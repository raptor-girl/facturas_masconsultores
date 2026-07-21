import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  invoicePreviewRequestSchema,
  invoicePreviewResponseSchema,
  ufDateParamsSchema,
  ufValueSchema,
} from '@factuflow/shared-schemas';
import type { Env } from '../../../config/env.js';
import type { IdentityService } from '../../../application/auth/identity-service.js';
import type { InvoicePreviewService, UfService } from '../../../application/uf/uf-service.js';
import { AppError } from '../../../application/errors.js';
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
  readonly uf: UfService;
  readonly calculations: InvoicePreviewService;
}

export function registerUfCalculationRoutes(
  app: FastifyInstance,
  { env, identity, uf, calculations }: Options,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const reader = async (request: FastifyRequest) => {
    const auth = await requireAuthentication(request, identity, env);
    requirePasswordChanged(auth);
    if (!auth.user.roles.some((role) => role === 'ADMIN' || role === 'COORDINATOR')) {
      throw new AppError('FORBIDDEN', 'No tiene permisos para esta operación.', 403);
    }
    return auth;
  };

  typed.route({
    method: 'GET',
    url: '/uf-values/:date',
    schema: {
      tags: ['UF y cálculos'],
      params: ufDateParamsSchema,
      response: { 200: ufValueSchema },
    },
    handler: async (request) => {
      const auth = await reader(request);
      return uf.get(request.params.date, auth, requestContext(request));
    },
  });

  typed.route({
    method: 'POST',
    url: '/admin/uf-values/:date/refresh',
    schema: {
      tags: ['administración'],
      params: ufDateParamsSchema,
      response: { 200: ufValueSchema },
    },
    handler: async (request) => {
      const auth = await reader(request);
      requireRole(auth, 'ADMIN');
      requireCsrf(request, identity, auth);
      return uf.refresh(request.params.date, auth, requestContext(request));
    },
  });

  typed.route({
    method: 'POST',
    url: '/calculations/invoice-preview',
    schema: {
      tags: ['UF y cálculos'],
      body: invoicePreviewRequestSchema,
      response: { 200: invoicePreviewResponseSchema },
    },
    handler: async (request) => {
      const auth = await reader(request);
      requireCsrf(request, identity, auth);
      return calculations.preview(request.body, auth, requestContext(request));
    },
  });
}
