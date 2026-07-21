import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  duplicateSourceResponseSchema,
  idempotencyHeadersSchema,
  invoiceRequestExportSchema,
  invoiceRequestIdParamsSchema,
  invoiceRequestListQuerySchema,
  invoiceRequestResponseSchema,
  invoiceRequestsPageSchema,
} from '@factuflow/shared-schemas';
import type { Env } from '../../../config/env.js';
import type { IdentityService } from '../../../application/auth/identity-service.js';
import type { InvoiceRequestService } from '../../../application/invoice-requests/invoice-request-service.js';
import { AppError } from '../../../application/errors.js';
import {
  requestContext,
  requireAuthentication,
  requireCsrf,
  requirePasswordChanged,
} from '../auth-guards.js';

interface Options {
  readonly env: Env;
  readonly identity: IdentityService;
  readonly invoiceRequests: InvoiceRequestService;
}

function safeDisposition(filename: string): string {
  if (!/^[A-Za-z0-9_.-]+\.xlsx$/.test(filename) || /[\r\n"]/u.test(filename)) {
    throw new Error('Nombre de exportación inseguro.');
  }
  return `attachment; filename="${filename}"`;
}

export function registerInvoiceRequestRoutes(
  app: FastifyInstance,
  { env, identity, invoiceRequests }: Options,
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
    method: 'POST',
    url: '/invoice-requests/export',
    schema: {
      tags: ['solicitudes de factura'],
      summary: 'Genera el XLSX y persiste una solicitud EXPORTED de forma atómica',
      description:
        'Devuelve el XLSX binario. Requiere Idempotency-Key; no crea borradores ni estados intermedios.',
      headers: idempotencyHeadersSchema,
      body: invoiceRequestExportSchema,
    },
    handler: async (request, reply) => {
      const auth = await reader(request);
      requireCsrf(request, identity, auth);
      const result = await invoiceRequests.exportAndPersist(
        request.body,
        request.headers['idempotency-key'],
        auth,
        requestContext(request),
      );
      return reply
        .type(result.mimeType)
        .header('content-disposition', safeDisposition(result.filename))
        .header('x-invoice-request-id', result.invoiceRequestId)
        .header('x-invoice-folio', result.folio)
        .header('x-export-sha256', result.sha256)
        .send(Buffer.from(result.bytes));
    },
  });

  typed.route({
    method: 'GET',
    url: '/invoice-requests',
    schema: {
      tags: ['solicitudes de factura'],
      querystring: invoiceRequestListQuerySchema,
      response: { 200: invoiceRequestsPageSchema },
    },
    handler: async (request) => {
      await reader(request);
      return invoiceRequests.list(request.query);
    },
  });

  typed.route({
    method: 'GET',
    url: '/invoice-requests/:id',
    schema: {
      tags: ['solicitudes de factura'],
      params: invoiceRequestIdParamsSchema,
      response: { 200: invoiceRequestResponseSchema },
    },
    handler: async (request) => {
      await reader(request);
      return { invoiceRequest: await invoiceRequests.get(request.params.id) };
    },
  });

  typed.route({
    method: 'GET',
    url: '/invoice-requests/:id/export',
    schema: {
      tags: ['solicitudes de factura'],
      params: invoiceRequestIdParamsSchema,
      summary: 'Descarga los bytes XLSX inmutables almacenados en PostgreSQL',
    },
    handler: async (request, reply) => {
      const auth = await reader(request);
      const result = await invoiceRequests.download(
        request.params.id,
        auth,
        requestContext(request),
      );
      return reply
        .type(result.mimeType)
        .header('content-disposition', safeDisposition(result.filename))
        .header('x-invoice-request-id', result.invoiceRequestId)
        .header('x-invoice-folio', result.folio)
        .header('x-export-sha256', result.sha256)
        .send(Buffer.from(result.bytes));
    },
  });

  typed.route({
    method: 'GET',
    url: '/invoice-requests/:id/duplicate-source',
    schema: {
      tags: ['solicitudes de factura'],
      params: invoiceRequestIdParamsSchema,
      response: { 200: duplicateSourceResponseSchema },
    },
    handler: async (request) => {
      await reader(request);
      return { source: await invoiceRequests.duplicateSource(request.params.id) };
    },
  });
}
