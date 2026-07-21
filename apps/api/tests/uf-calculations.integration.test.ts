import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { connect, startTestDatabase, type TestDatabase } from './setup/postgres.js';
import { createDb } from '../src/infrastructure/postgres/db.js';
import type { Database } from '../src/infrastructure/postgres/schema.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { buildServer } from '../src/presentation/http/server.js';
import { PostgresIdentityService } from '../src/infrastructure/postgres/identity-service.js';
import type { UfProvider, UfProviderResult } from '../src/application/uf/uf-provider.js';
import { UfProviderError } from '../src/application/uf/uf-provider.js';

interface Jar {
  cookie: string;
  csrf: string;
}

describe('UF y previsualización tributaria', () => {
  let database: TestDatabase;
  let db: Kysely<Database>;
  let env: Env;
  let app: FastifyInstance;
  let admin: Jar;
  let coordinator: Jar;
  let clientId = '';
  let otherClientId = '';
  let centerOne = '';
  let centerTwo = '';
  let otherCenter = '';
  let inactiveCenter = '';
  let siiCalls = 0;
  let mindicadorCalls = 0;
  let siiFetch: (date: string) => Promise<UfProviderResult> = () =>
    Promise.resolve({ status: 'not-published' });
  let mindicadorFetch: (date: string) => Promise<UfProviderResult> = () =>
    Promise.resolve({ status: 'not-published' });

  const providers: UfProvider[] = [
    {
      name: 'sii.cl',
      fetch: async (date) => {
        siiCalls += 1;
        return siiFetch(date);
      },
    },
    {
      name: 'mindicador.cl',
      fetch: async (date) => {
        mindicadorCalls += 1;
        return mindicadorFetch(date);
      },
    },
  ];

  const login = async (identifier: string, password: string): Promise<Jar> => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier, password },
    });
    expect(response.statusCode).toBe(200);
    const session = response.cookies.find((cookie) => cookie.name === env.SESSION_COOKIE_NAME)!;
    const csrf = response.cookies.find(
      (cookie) => cookie.name === `${env.SESSION_COOKIE_NAME}_csrf`,
    )!;
    return {
      cookie: `${session.name}=${session.value}; ${csrf.name}=${csrf.value}`,
      csrf: csrf.value,
    };
  };

  const request = (
    jar: Jar,
    options: {
      method: NonNullable<InjectOptions['method']>;
      url: string;
      payload?: NonNullable<InjectOptions['payload']>;
      csrf?: boolean;
    },
  ) =>
    app.inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        cookie: jar.cookie,
        ...(options.csrf === false ? {} : { 'x-csrf-token': jar.csrf }),
      },
    });

  const changePassword = async (jar: Jar, currentPassword: string, newPassword: string) => {
    expect(
      (
        await request(jar, {
          method: 'POST',
          url: '/auth/change-password',
          payload: { currentPassword, newPassword },
        })
      ).statusCode,
    ).toBe(200);
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL_APP: database.appUri,
      PASSWORD_HASH_MEMORY_KIB: '8192',
      PASSWORD_HASH_TIME_COST: '2',
      UF_REQUEST_RETRIES: '0',
    });
    db = createDb({ connectionString: env.DATABASE_URL_APP });
    app = await buildServer({ env, db, version: '0.4.0-test', ufProviders: providers });
    await app.ready();

    const identity = new PostgresIdentityService(db, env);
    const bootstrap = await identity.bootstrapAdmin({
      username: 'admin.phase4',
      email: 'admin.phase4@example.invalid',
      displayName: 'Admin fase cuatro',
    });
    admin = await login('admin.phase4', bootstrap.temporaryPassword);
    await changePassword(admin, bootstrap.temporaryPassword, 'Admin-Phase-Four-42!');

    const created = await request(admin, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'coordinator.phase4',
        email: 'coordinator.phase4@example.invalid',
        displayName: 'Coordinador fase cuatro',
        roles: ['COORDINATOR'],
      },
    });
    const temporary = created.json<{ temporaryPassword: string }>().temporaryPassword;
    coordinator = await login('coordinator.phase4', temporary);
    await changePassword(coordinator, temporary, 'Coordinator-Phase-Four-42!');

    const product = await db
      .insertInto('product')
      .values({ code: 'P4', name: 'Producto ficticio UF', normalized_name: 'producto ficticio uf' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const clients = await db
      .insertInto('client')
      .values([
        { short_name: 'Cliente UF Uno', data_status: 'PENDING_COMPLETION' },
        { short_name: 'Cliente UF Dos', data_status: 'PENDING_COMPLETION' },
      ])
      .returning('id')
      .execute();
    clientId = clients[0]?.id ?? '';
    otherClientId = clients[1]?.id ?? '';
    const centers = await db
      .insertInto('project_center')
      .values([
        {
          client_id: clientId,
          product_id: product.id,
          code: 'CP-UF-1',
          project_name: 'Proyecto UF uno',
          project_center_type: 'DEVELOPMENT_HOURS',
        },
        {
          client_id: clientId,
          product_id: product.id,
          code: 'CP-UF-2',
          project_name: 'Proyecto UF dos',
          project_center_type: 'CONSTRUCTION',
        },
        {
          client_id: otherClientId,
          product_id: product.id,
          code: 'CP-UF-OTRO',
          project_name: 'Proyecto UF otro cliente',
          project_center_type: 'ADMINISTRATION_OPERATION',
        },
        {
          client_id: clientId,
          product_id: product.id,
          code: 'CP-UF-INACTIVO',
          project_name: 'Proyecto UF inactivo',
          project_center_type: 'ADMINISTRATION_OPERATION',
          is_active: false,
        },
      ])
      .returning(['id', 'code'])
      .execute();
    centerOne = centers.find((row) => row.code === 'CP-UF-1')?.id ?? '';
    centerTwo = centers.find((row) => row.code === 'CP-UF-2')?.id ?? '';
    otherCenter = centers.find((row) => row.code === 'CP-UF-OTRO')?.id ?? '';
    inactiveCenter = centers.find((row) => row.code === 'CP-UF-INACTIVO')?.id ?? '';
    await db
      .insertInto('uf_value')
      .values({
        value_date: '2024-01-10',
        value: '40543.070000',
        source: 'sii.cl',
        fetched_at: new Date('2024-01-10T12:00:00.000Z'),
        source_reference: 'https://www.sii.cl/valores_y_fechas/uf/uf2024.htm',
        metadata: null,
      })
      .execute();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await database.stop();
  });

  it('exige autenticación, entrega caché como string y expone OpenAPI', async () => {
    expect((await app.inject({ method: 'GET', url: '/uf-values/2024-01-10' })).statusCode).toBe(
      401,
    );
    const before = siiCalls + mindicadorCalls;
    const response = await request(coordinator, { method: 'GET', url: '/uf-values/2024-01-10' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      date: '2024-01-10',
      value: '40543.07',
      source: 'sii.cl',
      fromCache: true,
    });
    expect(typeof response.json<{ value: unknown }>().value).toBe('string');
    expect(siiCalls + mindicadorCalls).toBe(before);
    const openapi = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(openapi.json<{ paths: Record<string, unknown> }>().paths).toHaveProperty(
      '/calculations/invoice-preview',
    );
  });

  it('consulta SII, guarda caché y audita la obtención', async () => {
    siiFetch = () =>
      Promise.resolve({
        status: 'found',
        value: '36815.55',
        sourceReference: 'https://www.sii.cl/valores_y_fechas/uf/uf2024.htm',
      });
    const response = await request(coordinator, { method: 'GET', url: '/uf-values/2024-01-15' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      value: '36815.55',
      source: 'sii.cl',
      fromCache: false,
    });
    const stored = await db
      .selectFrom('uf_value')
      .select(['value', 'source'])
      .where('value_date', '=', '2024-01-15')
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ value: '36815.550000', source: 'sii.cl' });
    expect(typeof stored.value).toBe('string');
    expect(
      await db
        .selectFrom('audit_event')
        .select('action')
        .where('action', '=', 'UF_VALUE_FETCHED')
        .where('entity_id', 'is not', null)
        .executeTakeFirst(),
    ).toBeTruthy();
  });

  it('usa fallback mindicador y audita el fallo minimizado del SII', async () => {
    siiFetch = () => {
      throw new UfProviderError('sii.cl', 'invalid-response', 'HTML ficticio inválido');
    };
    mindicadorFetch = () =>
      Promise.resolve({
        status: 'found',
        value: '36816.01',
        sourceReference: 'https://mindicador.cl/api/uf/2024',
      });
    const response = await request(admin, { method: 'GET', url: '/uf-values/2024-01-16' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: 'mindicador.cl', value: '36816.01' });
    const audit = await db
      .selectFrom('audit_event')
      .select(['reason', 'metadata'])
      .where('action', '=', 'UF_PROVIDER_FAILED')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('invalid-response');
    expect(JSON.stringify(audit.metadata)).not.toContain('HTML ficticio');
  });

  it('diferencia fecha inválida, futura, no publicada y proveedores caídos', async () => {
    expect((await request(admin, { method: 'GET', url: '/uf-values/2024-02-31' })).statusCode).toBe(
      400,
    );
    expect((await request(admin, { method: 'GET', url: '/uf-values/2099-01-01' })).statusCode).toBe(
      404,
    );
    siiFetch = () => Promise.resolve({ status: 'not-published' });
    mindicadorFetch = () => Promise.resolve({ status: 'not-published' });
    expect((await request(admin, { method: 'GET', url: '/uf-values/2024-01-17' })).statusCode).toBe(
      404,
    );
    siiFetch = () => {
      throw new UfProviderError('sii.cl', 'temporary', 'timeout');
    };
    mindicadorFetch = () => {
      throw new UfProviderError('mindicador.cl', 'temporary', 'timeout');
    };
    const unavailable = await request(admin, { method: 'GET', url: '/uf-values/2024-01-18' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json<{ error: { code: string } }>().error.code).toBe(
      'UF_PROVIDER_UNAVAILABLE',
    );
  });

  it('protege refresh con ADMIN y CSRF; registra antes/después al cambiar', async () => {
    mindicadorFetch = () => Promise.resolve({ status: 'not-published' });
    siiFetch = () =>
      Promise.resolve({
        status: 'found',
        value: '40544.08',
        sourceReference: 'https://www.sii.cl/valores_y_fechas/uf/uf2024.htm',
      });
    expect(
      (
        await request(coordinator, {
          method: 'POST',
          url: '/admin/uf-values/2024-01-10/refresh',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/admin/uf-values/2024-01-10/refresh',
          csrf: false,
        })
      ).statusCode,
    ).toBe(403);
    const refreshed = await request(admin, {
      method: 'POST',
      url: '/admin/uf-values/2024-01-10/refresh',
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ value: '40544.08', fromCache: false });
    const changed = await db
      .selectFrom('audit_event')
      .select(['changes_before', 'changes_after'])
      .where('action', '=', 'UF_VALUE_CHANGED')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(changed.changes_before).toMatchObject({ value: '40543.07', source: 'sii.cl' });
    expect(changed.changes_after).toMatchObject({ value: '40544.08', source: 'sii.cl' });
  });

  it('revierte la actualización cuando falla su auditoría crítica', async () => {
    const owner = await connect(database.ownerUri);
    await owner.query(`
      CREATE FUNCTION reject_uf_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'UF_VALUE_REFRESHED' THEN RAISE EXCEPTION 'audit failure test'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_uf_refresh_audit_trigger
      BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION reject_uf_refresh_audit();
    `);
    siiFetch = () =>
      Promise.resolve({
        status: 'found',
        value: '40545.09',
        sourceReference: 'https://www.sii.cl/valores_y_fechas/uf/uf2024.htm',
      });
    try {
      const response = await request(admin, {
        method: 'POST',
        url: '/admin/uf-values/2024-01-10/refresh',
      });
      expect(response.statusCode).toBe(500);
      const unchanged = await db
        .selectFrom('uf_value')
        .select('value')
        .where('value_date', '=', '2024-01-10')
        .executeTakeFirstOrThrow();
      expect(unchanged.value).toBe('40544.080000');
    } finally {
      await owner.query('DROP TRIGGER reject_uf_refresh_audit_trigger ON audit_event');
      await owner.query('DROP FUNCTION reject_uf_refresh_audit()');
      await owner.end();
    }
  });

  it('calcula por línea, afecto y exento sin persistir solicitud ni reservar folio', async () => {
    await db
      .updateTable('uf_value')
      .set({ value: '40543.070000' })
      .where('value_date', '=', '2024-01-10')
      .execute();
    const folioBefore = await db.selectFrom('folio_counter').selectAll().execute();
    const affected = await request(coordinator, {
      method: 'POST',
      url: '/calculations/invoice-preview',
      payload: {
        ufDate: '2024-01-10',
        taxTreatment: 'AFFECTED',
        lines: [
          { projectCenterId: centerOne, ufAmount: '10.5', position: 1 },
          { projectCenterId: centerTwo, ufAmount: '20.3', position: 2 },
        ],
      },
    });
    expect(affected.statusCode).toBe(200);
    expect(affected.json()).toMatchObject({
      algorithmVersion: 'LEGACY_V1',
      sumUf: '30.8',
      netClp: '1248726',
      ivaClp: '237260',
      totalClp: '1485986',
      ufValue: '40543.07',
      ufFromCache: true,
      clientId,
    });
    expect(affected.json<{ lines: { clpAmount: string }[] }>().lines).toMatchObject([
      { clpAmount: '425702' },
      { clpAmount: '823024' },
    ]);

    const exempt = await request(admin, {
      method: 'POST',
      url: '/calculations/invoice-preview',
      payload: {
        ufDate: '2024-01-10',
        ufValue: '40543.07',
        taxTreatment: 'EXEMPT',
        taxRate: '0',
        lines: [{ projectCenterId: centerOne, ufAmount: '1', position: 1 }],
      },
    });
    expect(exempt.json()).toMatchObject({ ivaClp: '0', totalClp: '40543', ufSource: null });
    expect(await db.selectFrom('folio_counter').selectAll().execute()).toEqual(folioBefore);
    const persisted = await sql<{
      requests: number;
      lines: number;
      receivers: number;
      exports: number;
    }>`
      SELECT
        (SELECT count(*)::integer FROM invoice_request) AS requests,
        (SELECT count(*)::integer FROM invoice_request_line) AS lines,
        (SELECT count(*)::integer FROM invoice_request_receiver) AS receivers,
        (SELECT count(*)::integer FROM invoice_export) AS exports
    `.execute(db);
    expect(persisted.rows).toEqual([{ requests: 0, lines: 0, receivers: 0, exports: 0 }]);
  });

  it('rechaza CP inexistente, inactivo y de clientes diferentes', async () => {
    const payload = (ids: string[]) => ({
      ufDate: '2024-01-10',
      ufValue: '40543.07',
      taxTreatment: 'EXEMPT',
      lines: ids.map((projectCenterId, index) => ({
        projectCenterId,
        ufAmount: '1',
        position: index + 1,
      })),
    });
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/calculations/invoice-preview',
          payload: payload(['00000000-0000-4000-8000-000000000099']),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/calculations/invoice-preview',
          payload: payload([inactiveCenter]),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/calculations/invoice-preview',
          payload: payload([centerOne, otherCenter]),
        })
      ).statusCode,
    ).toBe(422);
  });

  it('mantiene ownership y niega DELETE/TRUNCATE al rol de aplicación', async () => {
    const owner = await connect(database.ownerUri);
    const appClient = await connect(database.appUri);
    try {
      const relation = await owner.query<{ owner: string }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.relname = 'uf_value'`,
      );
      expect(relation.rows[0]?.owner).toBe('factuflow_owner');
      await expect(appClient.query('DELETE FROM uf_value WHERE false')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(appClient.query('TRUNCATE uf_value')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await owner.end();
      await appClient.end();
    }
  });
});
