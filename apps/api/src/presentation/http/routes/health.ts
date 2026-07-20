import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { healthResponseSchema, type HealthResponse } from '@factuflow/shared-schemas';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/schema.js';
import { pingDatabase } from '../../../infrastructure/postgres/db.js';

interface HealthRouteOptions {
  readonly db: Kysely<Database>;
  readonly version: string;
}

/**
 * GET /health — criterio de termino 4.
 *
 * No responde 200 solo por estar vivo: verifica de verdad la conexion con
 * PostgreSQL. Un healthcheck que devuelve "ok" sin tocar la base es peor que
 * no tener healthcheck, porque da confianza sin respaldo.
 *
 * Devuelve 200 si todo esta bien y 503 si la base no responde, para que un
 * orquestador pueda actuar.
 */
export function registerHealthRoute(
  app: FastifyInstance,
  { db, version }: HealthRouteOptions,
): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/health',
    schema: {
      description: 'Estado del servicio y de sus dependencias.',
      tags: ['sistema'],
      response: { 200: healthResponseSchema, 503: healthResponseSchema },
    },
    handler: async (_request, reply) => {
      let latencyMs: number | null = null;
      let postgresOk = false;

      try {
        latencyMs = await pingDatabase(db);
        postgresOk = true;
      } catch (error) {
        app.log.error({ err: error }, 'Healthcheck: PostgreSQL no responde');
      }

      const body: HealthResponse = {
        status: postgresOk ? 'ok' : 'degraded',
        version,
        uptimeSeconds: Math.round(process.uptime()),
        checks: [{ name: 'postgres', status: postgresOk ? 'ok' : 'degraded', latencyMs }],
      };

      return reply.status(postgresOk ? 200 : 503).send(body);
    },
  });
}
