import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  idempotencyHeadersSchema,
  legacyMasterImportParamsSchema,
  legacyMasterImportPayloadSchema,
  legacyMasterImportRunResponseSchema,
} from '@factuflow/shared-schemas';
import type { Env } from '../../../config/env.js';
import type { IdentityService } from '../../../application/auth/identity-service.js';
import type { MasterImportService } from '../../../application/billing/master-import-service.js';
import {
  requestContext,
  requireAuthentication,
  requireCsrf,
  requirePasswordChanged,
  requireRole,
} from '../auth-guards.js';

interface Options {
  readonly env: Env;
  readonly identity: IdentityService;
  readonly imports: MasterImportService;
}

export function registerMasterImportRoutes(
  app: FastifyInstance,
  { env, identity, imports }: Options,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const admin = async (request: FastifyRequest) => {
    const auth = await requireAuthentication(request, identity, env);
    requirePasswordChanged(auth);
    requireRole(auth, 'ADMIN');
    return auth;
  };

  typed.route({
    method: 'POST',
    url: '/admin/imports/masters/preview',
    schema: {
      tags: ['importación'],
      summary: 'Valida y previsualiza una carga controlada de maestros legacy',
      headers: idempotencyHeadersSchema,
      body: legacyMasterImportPayloadSchema,
      response: { 200: legacyMasterImportRunResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      requireCsrf(request, identity, auth);
      return {
        importRun: await imports.preview(
          auth,
          request.body,
          request.headers['idempotency-key'],
          requestContext(request),
        ),
      };
    },
  });

  typed.route({
    method: 'POST',
    url: '/admin/imports/masters/apply',
    schema: {
      tags: ['importación'],
      summary: 'Aplica una carga controlada de maestros legacy de forma transaccional',
      headers: idempotencyHeadersSchema,
      body: legacyMasterImportPayloadSchema,
      response: { 200: legacyMasterImportRunResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      requireCsrf(request, identity, auth);
      return {
        importRun: await imports.apply(
          auth,
          request.body,
          request.headers['idempotency-key'],
          requestContext(request),
        ),
      };
    },
  });

  typed.route({
    method: 'GET',
    url: '/admin/imports/masters/:id',
    schema: {
      tags: ['importación'],
      params: legacyMasterImportParamsSchema,
      response: { 200: legacyMasterImportRunResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return { importRun: await imports.get(auth, request.params.id) };
    },
  });
}
