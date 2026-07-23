import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import type { Kysely } from 'kysely';
import { startTestDatabase, type TestDatabase } from './setup/postgres.js';
import { createDb } from '../src/infrastructure/postgres/db.js';
import type { Database } from '../src/infrastructure/postgres/schema.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { buildServer } from '../src/presentation/http/server.js';
import { PostgresIdentityService } from '../src/infrastructure/postgres/identity-service.js';
import { calculateChileanRutCheckDigit } from '../src/domain/billing/chilean-rut.js';
import type { LegacyMasterImportPayload } from '@factuflow/shared-schemas';

interface Jar {
  cookie: string;
  csrf: string;
}

describe('importador controlado de maestros legacy', () => {
  let database: TestDatabase;
  let db: Kysely<Database>;
  let env: Env;
  let app: FastifyInstance;
  let admin: Jar;
  let coordinator: Jar;

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
      idempotencyKey?: string;
    },
  ) =>
    app.inject({
      ...options,
      headers: {
        cookie: jar.cookie,
        'x-csrf-token': jar.csrf,
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      },
    });

  const payload = (suffix = '001'): LegacyMasterImportPayload => ({
    sourceName: `legacy-fixture-${suffix}`,
    options: { allowUpdates: false },
    issuerCompanies: [
      {
        externalId: `issuer-${suffix}`,
        code: `ISS-LEG-${suffix}`,
        legalName: `Emisora legacy ficticia ${suffix}`,
        taxId: rut('76123456'),
        businessActivity: 'Servicios ficticios legacy',
        address: 'Av. Ficticia 100',
        defaultTaxTreatment: 'AFFECTED',
        defaultIvaRate: '0.19',
        isActive: true,
      },
    ],
    coordinators: [
      {
        externalId: `coord-${suffix}`,
        displayName: `Responsable legacy ${suffix}`,
        email: `legacy.coord.${suffix}@example.invalid`,
        isActive: true,
      },
    ],
    products: [
      {
        externalId: `product-${suffix}`,
        code: `PROD-${suffix}`,
        name: `Producto legacy ${suffix}`,
        isActive: true,
      },
    ],
    clients: [
      {
        externalId: `client-${suffix}`,
        shortName: `Cliente Legacy ${suffix}`,
        legalName: `Cliente Legacy ${suffix} SpA`,
        taxId: rut('77123456'),
        businessActivity: 'Giro ficticio legacy',
        address: 'Calle Legacy 42',
        defaultCoordinatorExternalId: `coord-${suffix}`,
        dataStatus: 'COMPLETE',
        isActive: true,
      },
    ],
    invoiceRules: [
      {
        clientExternalId: `client-${suffix}`,
        purchaseOrderRequirement: 'OPTIONAL',
        hesRequirement: 'NOT_APPLICABLE',
        contractRequirement: 'OPTIONAL',
        supplierNumber: 'SUP-LEG-1',
        defaultIssuerCompanyExternalId: `issuer-${suffix}`,
        defaultTaxTreatment: 'AFFECTED',
        excelTemplateVariant: 'STANDARD',
        billingNotes: 'Notas ficticias legacy',
        isActive: true,
      },
    ],
    receivers: [
      {
        externalId: `receiver-${suffix}`,
        clientExternalId: `client-${suffix}`,
        displayName: `Receptor legacy ${suffix}`,
        email: `receiver.legacy.${suffix}@example.invalid`,
        isActive: true,
      },
    ],
    projectCenters: [
      {
        externalId: `pc-${suffix}`,
        clientExternalId: `client-${suffix}`,
        productExternalId: `product-${suffix}`,
        code: `CP-LEG-${suffix}`,
        projectName: `Proyecto legacy ${suffix}`,
        projectCenterType: 'ADMINISTRATION_OPERATION',
        isActive: true,
      },
    ],
  });

  const counts = async () => ({
    issuers: Number(
      (
        await db
          .selectFrom('issuer_company')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    coordinators: Number(
      (
        await db
          .selectFrom('coordinator_profile')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    clients: Number(
      (await db.selectFrom('client').select(db.fn.countAll().as('count')).executeTakeFirstOrThrow())
        .count,
    ),
    rules: Number(
      (
        await db
          .selectFrom('client_invoice_rule')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    receivers: Number(
      (
        await db
          .selectFrom('receiver')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    products: Number(
      (
        await db
          .selectFrom('product')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    projectCenters: Number(
      (
        await db
          .selectFrom('project_center')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    invoiceRequests: Number(
      (
        await db
          .selectFrom('invoice_request')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    folioCounters: Number(
      (
        await db
          .selectFrom('folio_counter')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
  });

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
    app = await buildServer({ env, db, version: '0.6.0-test' });
    await app.ready();
    const bootstrap = await new PostgresIdentityService(db, env).bootstrapAdmin({
      username: 'admin.phase6',
      email: 'admin.phase6@example.invalid',
      displayName: 'Admin fase seis',
    });
    admin = (await login('admin.phase6', bootstrap.temporaryPassword)).jar!;
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/auth/change-password',
          payload: {
            currentPassword: bootstrap.temporaryPassword,
            newPassword: 'Admin-Phase-Six-42!',
          },
        })
      ).statusCode,
    ).toBe(200);

    const created = await request(admin, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'coordinator.phase6',
        email: 'coordinator.phase6@example.invalid',
        displayName: 'Coordinador fase seis',
        roles: ['COORDINATOR'],
      },
    });
    const temporary = created.json<{ temporaryPassword: string }>().temporaryPassword;
    coordinator = (await login('coordinator.phase6', temporary)).jar!;
    expect(
      (
        await request(coordinator, {
          method: 'POST',
          url: '/auth/change-password',
          payload: { currentPassword: temporary, newPassword: 'Coordinator-Phase-Six-42!' },
        })
      ).statusCode,
    ).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await database.stop();
  });

  it('exige ADMIN, CSRF e Idempotency-Key y publica OpenAPI', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/imports/masters/preview',
          payload: payload(),
          headers: { 'idempotency-key': 'phase6-anonymous-denied' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await request(coordinator, {
          method: 'POST',
          url: '/admin/imports/masters/preview',
          payload: payload(),
          idempotencyKey: 'phase6-coordinator-denied',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/imports/masters/preview',
          payload: payload(),
          headers: { cookie: admin.cookie, 'idempotency-key': 'phase6-no-csrf-001' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/admin/imports/masters/preview',
          payload: payload(),
        })
      ).statusCode,
    ).toBe(400);
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.statusCode).toBe(200);
    expect(docs.body).toContain('/admin/imports/masters/preview');
    expect(docs.body).toContain('/admin/imports/masters/apply');
  });

  it('preview registra trazabilidad sin mutar maestros ni folios', async () => {
    const before = await counts();
    const response = await request(admin, {
      method: 'POST',
      url: '/admin/imports/masters/preview',
      payload: payload('preview'),
      idempotencyKey: 'phase6-preview-0001',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      importRun: { id: string; status: string; summary: { create: number; error: number } };
    }>();
    expect(body.importRun.status).toBe('PREVIEWED');
    expect(body.importRun.summary.create).toBe(7);
    expect(body.importRun.summary.error).toBe(0);
    expect(await counts()).toEqual(before);
    expect(
      await db
        .selectFrom('legacy_master_import_item')
        .select('id')
        .where('run_id', '=', body.importRun.id)
        .execute(),
    ).toHaveLength(7);
    expect(
      await db
        .selectFrom('audit_event')
        .select('id')
        .where('action', '=', 'LEGACY_MASTER_IMPORT_PREVIEWED')
        .where('entity_id', '=', body.importRun.id)
        .executeTakeFirst(),
    ).toBeTruthy();
  });

  it('apply crea maestros, mapeos y auditoría de forma idempotente sin tocar solicitudes', async () => {
    const before = await counts();
    const input = payload('apply');
    const response = await request(admin, {
      method: 'POST',
      url: '/admin/imports/masters/apply',
      payload: input,
      idempotencyKey: 'phase6-apply-0001',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      importRun: { id: string; status: string; summary: { create: number; error: number } };
    }>();
    expect(body.importRun.status).toBe('APPLIED');
    expect(body.importRun.summary).toMatchObject({ create: 7, error: 0 });
    expect(await counts()).toMatchObject({
      issuers: before.issuers + 1,
      coordinators: before.coordinators + 1,
      clients: before.clients + 1,
      rules: before.rules + 1,
      receivers: before.receivers + 1,
      products: before.products + 1,
      projectCenters: before.projectCenters + 1,
      invoiceRequests: before.invoiceRequests,
      folioCounters: before.folioCounters,
    });
    expect(
      await db
        .selectFrom('legacy_master_import_mapping')
        .select('external_id')
        .where('source_name', '=', input.sourceName)
        .orderBy('external_id')
        .execute(),
    ).toHaveLength(6);
    expect(
      await db
        .selectFrom('audit_event')
        .select('id')
        .where('action', '=', 'LEGACY_MASTER_IMPORT_APPLIED')
        .where('entity_id', '=', body.importRun.id)
        .executeTakeFirst(),
    ).toBeTruthy();

    const repeat = await request(admin, {
      method: 'POST',
      url: '/admin/imports/masters/apply',
      payload: input,
      idempotencyKey: 'phase6-apply-0001',
    });
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json<{ importRun: { id: string } }>().importRun.id).toBe(body.importRun.id);
    expect(await counts()).toMatchObject({
      issuers: before.issuers + 1,
      clients: before.clients + 1,
      invoiceRequests: before.invoiceRequests,
      folioCounters: before.folioCounters,
    });

    const conflict = await request(admin, {
      method: 'POST',
      url: '/admin/imports/masters/apply',
      payload: payload('different'),
      idempotencyKey: 'phase6-apply-0001',
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('rechaza apply si aparecen errores durante la aplicacion y revierte cambios parciales', async () => {
    const before = await counts();
    const input: LegacyMasterImportPayload = {
      sourceName: 'legacy-fixture-apply-error-items',
      options: { allowUpdates: false },
      issuerCompanies: [],
      coordinators: [],
      clients: [],
      invoiceRules: [],
      receivers: [],
      products: [
        {
          externalId: 'product-talento-canonical',
          code: null,
          name: 'Talento',
          isActive: true,
        },
        {
          externalId: 'product-talentos-alias',
          code: null,
          name: 'Talentos',
          isActive: true,
        },
      ],
      projectCenters: [],
    };

    const response = await request(admin, {
      method: 'POST',
      url: '/admin/imports/masters/apply',
      payload: input,
      idempotencyKey: 'phase6-apply-error-items-01',
    });
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<{
      importRun: {
        id: string;
        status: string;
        summary: { create: number; error: number };
      };
    }>().importRun;
    expect(run.status).toBe('REJECTED');
    expect(run.summary).toMatchObject({ create: 1, error: 1 });
    expect(await counts()).toEqual(before);
    expect(
      await db
        .selectFrom('legacy_master_import_item')
        .select(['operation', 'external_id'])
        .where('run_id', '=', run.id)
        .where('operation', '=', 'ERROR')
        .execute(),
    ).toEqual([{ operation: 'ERROR', external_id: 'product-talentos-alias' }]);
    expect(
      await db
        .selectFrom('audit_event')
        .select('id')
        .where('action', '=', 'LEGACY_MASTER_IMPORT_REJECTED')
        .where('entity_id', '=', run.id)
        .executeTakeFirst(),
    ).toBeTruthy();
  });

  it('importa CP/MS legacy sin producto directo porque producto es clasificacion opcional', async () => {
    const before = await counts();
    const input: LegacyMasterImportPayload = {
      sourceName: 'legacy-fixture-productless',
      options: { allowUpdates: false },
      issuerCompanies: [],
      coordinators: [],
      products: [],
      clients: [
        {
          externalId: 'client-productless',
          shortName: 'Cliente Legacy Sin Producto',
          legalName: 'Cliente Legacy Sin Producto SpA',
          taxId: rut('77123457'),
          businessActivity: 'Giro ficticio legacy',
          address: 'Calle Legacy 43',
          defaultCoordinatorExternalId: null,
          dataStatus: 'COMPLETE',
          isActive: true,
        },
      ],
      invoiceRules: [],
      receivers: [],
      projectCenters: [
        {
          externalId: 'pc-productless',
          clientExternalId: 'client-productless',
          productExternalId: null,
          code: 'CP-LEG-SIN-PROD',
          projectName: 'Proyecto legacy sin producto',
          projectCenterType: 'ADMINISTRATION_OPERATION',
          isActive: true,
        },
      ],
    };

    const response = await request(admin, {
      method: 'POST',
      url: '/admin/imports/masters/apply',
      payload: input,
      idempotencyKey: 'phase6-productless-01',
    });
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<{
      importRun: { status: string; summary: { create: number; error: number } };
    }>().importRun;
    expect(run.status).toBe('APPLIED');
    expect(run.summary).toMatchObject({ create: 2, error: 0 });
    expect(await counts()).toMatchObject({
      clients: before.clients + 1,
      products: before.products,
      projectCenters: before.projectCenters + 1,
      invoiceRequests: before.invoiceRequests,
      folioCounters: before.folioCounters,
    });
    expect(
      await db
        .selectFrom('project_center')
        .select(['code', 'product_id'])
        .where('code', '=', 'CP-LEG-SIN-PROD')
        .executeTakeFirst(),
    ).toMatchObject({ code: 'CP-LEG-SIN-PROD', product_id: null });
  });

  it('rechaza referencias inválidas sin cambios de maestros y sin crear usuarios', async () => {
    const before = await counts();
    const usersBefore = Number(
      (
        await db
          .selectFrom('app_user')
          .select(db.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    );
    const bad: LegacyMasterImportPayload = {
      sourceName: 'legacy-fixture-bad',
      options: { allowUpdates: false },
      issuerCompanies: [],
      coordinators: [],
      clients: [],
      invoiceRules: [],
      receivers: [
        {
          externalId: 'receiver-bad',
          clientExternalId: 'missing-client',
          displayName: 'Receptor inválido',
          email: 'invalid.receiver@example.invalid',
          isActive: true,
        },
      ],
      products: [],
      projectCenters: [],
    };
    const response = await request(admin, {
      method: 'POST',
      url: '/admin/imports/masters/apply',
      payload: bad,
      idempotencyKey: 'phase6-bad-reference-01',
    });
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<{
      importRun: { id: string; status: string; summary: { error: number } };
    }>().importRun;
    expect(run.status).toBe('REJECTED');
    expect(run.summary.error).toBe(1);
    expect(await counts()).toEqual(before);
    expect(
      Number(
        (
          await db
            .selectFrom('app_user')
            .select(db.fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(usersBefore);
    expect(
      await db
        .selectFrom('audit_event')
        .select('id')
        .where('action', '=', 'LEGACY_MASTER_IMPORT_REJECTED')
        .where('entity_id', '=', run.id)
        .executeTakeFirst(),
    ).toBeTruthy();
  });
});
