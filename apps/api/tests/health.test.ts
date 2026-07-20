import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDatabase, type TestDatabase } from './setup/postgres.js';
import { createDb } from '../src/infrastructure/postgres/db.js';
import { buildServer } from '../src/presentation/http/server.js';
import { loadEnv } from '../src/config/env.js';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../src/infrastructure/postgres/schema.js';

/**
 * Criterio de termino 4 — /health responde y verifica PostgreSQL de verdad.
 */
describe('GET /health', () => {
  let database: TestDatabase;
  let db: Kysely<Database>;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await startTestDatabase();
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL_APP: database.appUri,
    });

    db = createDb({ connectionString: env.DATABASE_URL_APP });
    app = await buildServer({ env, db, version: '0.1.0-test' });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await database.stop();
  });

  it('responde 200 con estado ok cuando PostgreSQL esta disponible', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      status: string;
      version: string;
      uptimeSeconds: number;
      checks: { name: string; status: string; latencyMs: number | null }[];
    }>();

    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0-test');
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]?.name).toBe('postgres');
    expect(body.checks[0]?.status).toBe('ok');
    expect(body.checks[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('responde 503 y degraded cuando PostgreSQL no responde', async () => {
    // Un healthcheck que sigue diciendo "ok" con la base caida es peor que no
    // tenerlo: da confianza sin respaldo.
    const brokenDb = createDb({
      connectionString: 'postgresql://factuflow_app:x@127.0.0.1:1/nada',
    });
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL_APP: 'postgresql://factuflow_app:x@127.0.0.1:1/nada',
    });

    const brokenApp = await buildServer({ env, db: brokenDb, version: '0.1.0-test' });
    await brokenApp.ready();

    try {
      const response = await brokenApp.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ status: string }>().status).toBe('degraded');
    } finally {
      await brokenApp.close();
      await brokenDb.destroy();
    }
  });

  it('expone el contrato OpenAPI generado desde los esquemas Zod', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ paths: Record<string, unknown> }>().paths).toHaveProperty('/health');
  });
});
