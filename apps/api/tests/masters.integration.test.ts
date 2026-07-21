import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import type { Kysely } from 'kysely';
import { startTestDatabase, connect, type TestDatabase } from './setup/postgres.js';
import { createDb } from '../src/infrastructure/postgres/db.js';
import type { Database } from '../src/infrastructure/postgres/schema.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { buildServer } from '../src/presentation/http/server.js';
import { PostgresIdentityService } from '../src/infrastructure/postgres/identity-service.js';
import { calculateChileanRutCheckDigit } from '../src/domain/billing/chilean-rut.js';

interface Jar {
  cookie: string;
  csrf: string;
}

describe('maestros de facturación', () => {
  let database: TestDatabase;
  let db: Kysely<Database>;
  let env: Env;
  let app: FastifyInstance;
  let admin: Jar;
  let coordinator: Jar;
  let issuerId = '';
  let coordinatorProfileId = '';
  let completeClientId = '';
  let pendingClientId = '';
  let productId = '';
  let projectCenterId = '';

  const rut = (body: string) => `${body}-${calculateChileanRutCheckDigit(body)}`;
  const login = async (
    identifier: string,
    password: string,
  ): Promise<{ response: InjectResponse; jar?: Jar }> => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier, password },
    });
    if (response.statusCode !== 200) return { response };
    const session = response.cookies.find((cookie) => cookie.name === env.SESSION_COOKIE_NAME)!;
    const csrf = response.cookies.find(
      (cookie) => cookie.name === `${env.SESSION_COOKIE_NAME}_csrf`,
    )!;
    return {
      response,
      jar: {
        cookie: `${session.name}=${session.value}; ${csrf.name}=${csrf.value}`,
        csrf: csrf.value,
      },
    };
  };
  const request = (
    jar: Jar,
    options: {
      method: NonNullable<InjectOptions['method']>;
      url: string;
      payload?: NonNullable<InjectOptions['payload']>;
    },
  ) => app.inject({ ...options, headers: { cookie: jar.cookie, 'x-csrf-token': jar.csrf } });

  beforeAll(async () => {
    database = await startTestDatabase();
    env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL_APP: database.appUri,
      PASSWORD_HASH_MEMORY_KIB: '8192',
      PASSWORD_HASH_TIME_COST: '2',
    });
    db = createDb({ connectionString: env.DATABASE_URL_APP });
    app = await buildServer({ env, db, version: '0.3.0-test' });
    await app.ready();
    const bootstrap = await new PostgresIdentityService(db, env).bootstrapAdmin({
      username: 'admin.phase3',
      email: 'admin.phase3@example.invalid',
      displayName: 'Admin fase tres',
    });
    admin = (await login('admin.phase3', bootstrap.temporaryPassword)).jar!;
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/auth/change-password',
          payload: {
            currentPassword: bootstrap.temporaryPassword,
            newPassword: 'Admin-Phase-Three-42!',
          },
        })
      ).statusCode,
    ).toBe(200);

    const created = await request(admin, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'coordinator.phase3',
        email: 'coordinator.phase3@example.invalid',
        displayName: 'Coordinador fase tres',
        roles: ['COORDINATOR'],
      },
    });
    const temporary = created.json<{ temporaryPassword: string }>().temporaryPassword;
    coordinator = (await login('coordinator.phase3', temporary)).jar!;
    expect(
      (
        await request(coordinator, {
          method: 'POST',
          url: '/auth/change-password',
          payload: { currentPassword: temporary, newPassword: 'Coordinator-Phase-Three-42!' },
        })
      ).statusCode,
    ).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await database.stop();
  });

  it('exige autenticación y permite lectura, no escritura, a COORDINATOR', async () => {
    expect((await app.inject({ method: 'GET', url: '/products' })).statusCode).toBe(401);
    expect((await request(coordinator, { method: 'GET', url: '/products' })).statusCode).toBe(200);
    expect(
      (
        await request(coordinator, {
          method: 'POST',
          url: '/admin/products',
          payload: { name: 'No permitido', code: null },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('crea emisora con NUMERIC como string, valida RUT y duplicados', async () => {
    const response = await request(admin, {
      method: 'POST',
      url: '/admin/issuer-companies',
      payload: {
        code: 'ISS-TEST',
        legalName: 'Emisora ficticia',
        taxId: rut('76543210'),
        businessActivity: 'Servicios ficticios',
        address: 'Calle Ficticia 123',
        defaultTaxTreatment: 'AFFECTED',
        defaultIvaRate: '0.19',
      },
    });
    expect(response.statusCode).toBe(201);
    const company = response.json<{ issuerCompany: { id: string; defaultIvaRate: string } }>()
      .issuerCompany;
    issuerId = company.id;
    expect(company.defaultIvaRate).toBe('0.1900');
    expect(typeof company.defaultIvaRate).toBe('string');
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/admin/issuer-companies',
          payload: {
            code: 'other',
            legalName: 'Otro',
            taxId: '12.345.678-4',
            businessActivity: 'X',
            address: 'Y',
            defaultTaxTreatment: 'EXEMPT',
            defaultIvaRate: '0',
          },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/admin/issuer-companies',
          payload: {
            code: 'iss-test',
            legalName: 'Duplicada',
            taxId: rut('11111111'),
            businessActivity: 'X',
            address: 'Y',
            defaultTaxTreatment: 'EXEMPT',
            defaultIvaRate: '0',
          },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('separa perfil responsable de app_user y conserva vínculo opcional único', async () => {
    const user = await db
      .selectFrom('app_user')
      .select('id')
      .where('username', '=', 'coordinator.phase3')
      .executeTakeFirstOrThrow();
    const response = await request(admin, {
      method: 'POST',
      url: '/admin/coordinators',
      payload: {
        displayName: 'Responsable ficticio',
        email: 'responsable@example.invalid',
        appUserId: user.id,
      },
    });
    expect(response.statusCode).toBe(201);
    coordinatorProfileId = response.json<{ coordinator: { id: string; appUserId: string } }>()
      .coordinator.id;
    const unlinked = await request(admin, {
      method: 'POST',
      url: `/admin/coordinators/${coordinatorProfileId}/unlink-user`,
    });
    expect(unlinked.statusCode).toBe(200);
    const relinked = await request(admin, {
      method: 'POST',
      url: `/admin/coordinators/${coordinatorProfileId}/link-user`,
      payload: { appUserId: user.id },
    });
    expect(relinked.statusCode).toBe(200);
  });

  it('crea cliente completo y pendiente; valida datos, búsqueda y unicidad', async () => {
    const complete = await request(admin, {
      method: 'POST',
      url: '/admin/clients',
      payload: {
        shortName: 'Cliente Uno',
        legalName: 'Cliente Uno Ficticio',
        taxId: rut('12345678'),
        businessActivity: 'Actividad ficticia',
        address: 'Dirección ficticia 1',
        defaultCoordinatorProfileId: coordinatorProfileId,
        dataStatus: 'COMPLETE',
      },
    });
    expect(complete.statusCode).toBe(201);
    completeClientId = complete.json<{ client: { id: string } }>().client.id;
    const pending = await request(admin, {
      method: 'POST',
      url: '/admin/clients',
      payload: {
        shortName: 'Cliente Pendiente',
        legalName: null,
        taxId: null,
        businessActivity: null,
        address: null,
        defaultCoordinatorProfileId: null,
        dataStatus: 'PENDING_COMPLETION',
      },
    });
    expect(pending.statusCode).toBe(201);
    pendingClientId = pending.json<{ client: { id: string } }>().client.id;
    const incomplete = await request(admin, {
      method: 'POST',
      url: '/admin/clients',
      payload: {
        shortName: 'Completo inválido',
        legalName: null,
        taxId: null,
        businessActivity: null,
        address: null,
        defaultCoordinatorProfileId: null,
        dataStatus: 'COMPLETE',
      },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/admin/clients',
          payload: {
            shortName: 'CLIENTE UNO',
            legalName: null,
            taxId: null,
            businessActivity: null,
            address: null,
            defaultCoordinatorProfileId: null,
            dataStatus: 'PENDING_COMPLETION',
          },
        })
      ).statusCode,
    ).toBe(409);
    const search = await request(coordinator, {
      method: 'GET',
      url: '/clients/search?q=12345678&pageSize=5',
    });
    expect(search.json<{ total: number }>().total).toBe(1);
  });

  it('guarda regla explícita HABITAT sin inferir nombres', async () => {
    const response = await request(admin, {
      method: 'PUT',
      url: `/admin/clients/${completeClientId}/invoice-rule`,
      payload: {
        purchaseOrderRequirement: 'REQUIRED',
        hesRequirement: 'OPTIONAL',
        contractRequirement: 'REQUIRED',
        supplierNumber: 'SUP-FICTICIO',
        defaultIssuerCompanyId: issuerId,
        defaultTaxTreatment: 'AFFECTED',
        excelTemplateVariant: 'HABITAT',
        billingNotes: 'Nota ficticia',
        isActive: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ invoiceRule: { excelTemplateVariant: string } }>().invoiceRule
        .excelTemplateVariant,
    ).toBe('HABITAT');
  });

  it('receptores son únicos activos por cliente y repetibles entre clientes', async () => {
    const payload = { displayName: 'Receptor ficticio', email: 'billing@example.invalid' };
    const first = await request(admin, {
      method: 'POST',
      url: `/admin/clients/${completeClientId}/receivers`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: `/admin/clients/${completeClientId}/receivers`,
          payload: { ...payload, email: 'BILLING@EXAMPLE.INVALID' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: `/admin/clients/${pendingClientId}/receivers`,
          payload,
        })
      ).statusCode,
    ).toBe(201);
    const receiverId = first.json<{ receiver: { id: string } }>().receiver.id;
    expect(
      (await request(admin, { method: 'POST', url: `/admin/receivers/${receiverId}/deactivate` }))
        .statusCode,
    ).toBe(200);
  });

  it('normaliza productos y relaciona CP directamente con cliente y producto', async () => {
    const product = await request(admin, {
      method: 'POST',
      url: '/admin/products',
      payload: { code: 'PROD-1', name: 'Talento' },
    });
    expect(product.statusCode).toBe(201);
    productId = product.json<{ product: { id: string } }>().product.id;
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/admin/products',
          payload: { code: 'PROD-2', name: '  TALENTOS ' },
        })
      ).statusCode,
    ).toBe(409);
    const cp = await request(admin, {
      method: 'POST',
      url: `/admin/clients/${completeClientId}/project-centers`,
      payload: {
        productId,
        code: 'CP-001',
        projectName: 'Proyecto ficticio',
        projectCenterType: 'DEVELOPMENT_HOURS',
      },
    });
    expect(cp.statusCode).toBe(201);
    projectCenterId = cp.json<{ projectCenter: { id: string; productName: string } }>()
      .projectCenter.id;
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: `/admin/clients/${completeClientId}/project-centers`,
          payload: {
            productId,
            code: 'cp-001',
            projectName: 'Duplicado',
            projectCenterType: 'CONSTRUCTION',
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: `/admin/clients/${pendingClientId}/project-centers`,
          payload: {
            productId,
            code: 'CP-001',
            projectName: 'Permitido otro cliente',
            projectCenterType: 'CONSTRUCTION',
          },
        })
      ).statusCode,
    ).toBe(201);
    await request(admin, { method: 'POST', url: `/admin/clients/${pendingClientId}/deactivate` });
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: `/admin/clients/${pendingClientId}/project-centers`,
          payload: {
            productId,
            code: 'CP-002',
            projectName: 'No permitido',
            projectCenterType: 'CONSTRUCTION',
          },
        })
      ).statusCode,
    ).toBe(422);
  });

  it('OpenAPI contiene rutas y auditoría registra antes/después sin secretos', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    const paths = docs.json<{ paths: Record<string, unknown> }>().paths;
    expect(paths).toHaveProperty('/clients');
    expect(paths).toHaveProperty('/admin/clients/{id}/invoice-rule');
    await request(admin, {
      method: 'PATCH',
      url: `/admin/project-centers/${projectCenterId}`,
      payload: { projectName: 'Proyecto ficticio actualizado' },
    });
    const audit = await db
      .selectFrom('audit_event')
      .select(['action', 'changes_before', 'changes_after'])
      .where('action', 'like', '%PROJECT_CENTER%')
      .execute();
    expect(audit.map((event) => event.action)).toContain('PROJECT_CENTER_UPDATED');
    expect(audit.some((event) => event.changes_before && event.changes_after)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/password|token|cookie/i);
  });

  it('revierte una operación si falla su auditoría crítica', async () => {
    const owner = await connect(database.ownerUri);
    try {
      const before = await db
        .selectFrom('product')
        .select('name')
        .where('id', '=', productId)
        .executeTakeFirstOrThrow();
      await owner.query('REVOKE INSERT ON audit_event FROM factuflow_app');
      const response = await request(admin, {
        method: 'PATCH',
        url: `/admin/products/${productId}`,
        payload: { name: 'Cambio que debe revertirse' },
      });
      expect(response.statusCode).toBe(500);
      const after = await db
        .selectFrom('product')
        .select('name')
        .where('id', '=', productId)
        .executeTakeFirstOrThrow();
      expect(after.name).toBe(before.name);
    } finally {
      await owner.query('GRANT INSERT ON audit_event TO factuflow_app');
      await owner.end();
    }
  });

  it('el rol de aplicación no puede borrar maestros', async () => {
    await expect(
      db.deleteFrom('product').where('id', '=', productId).execute(),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
