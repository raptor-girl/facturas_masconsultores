import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError } from '../../application/errors.js';

/**
 * Manejo centralizado de errores.
 *
 * Dos objetivos, en este orden:
 *
 *  1. No filtrar nada. Un stack trace, un mensaje de PostgreSQL o una consulta
 *     en el cuerpo de una respuesta HTTP son una fuga de información. El cliente
 *     recibe un código estable y un requestId; el detalle vive sólo en el log
 *     del servidor.
 *  2. Ser depurable. Por eso el `requestId` viaja en la respuesta Y en el log:
 *     con ese identificador se reconstruye qué pasó sin exponerle nada a nadie.
 *
 * En la Fase 2, `requestId` es también lo que amarra una respuesta con su fila
 * en `audit_event.request_id`.
 */

export { AppError } from '../../application/errors.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

/** Códigos de PostgreSQL que nunca deben describirse al cliente. */
function isDatabaseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  );
}

function isHttpError(
  error: unknown,
): error is { statusCode: number; code?: string; message: string } {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    (!('code' in error) || error.code === undefined || typeof error.code === 'string')
  );
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: 'El recurso solicitado no existe.',
        requestId: request.id,
      },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    // ── Validación de entrada: seguro de detallar, es culpa del request ────
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ err: error, reqId: request.id }, 'Entrada inválida');
      const body: ErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'La solicitud no cumple el contrato esperado.',
          requestId: request.id,
          details: error.validation,
        },
      };
      return reply.status(400).send(body);
    }

    // ── Serialización de salida: bug NUESTRO, nunca se detalla al cliente ──
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, reqId: request.id }, 'La respuesta no cumple su esquema');
      const body: ErrorBody = {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Error interno.',
          requestId: request.id,
        },
      };
      return reply.status(500).send(body);
    }

    // ── Errores de dominio: mensaje pensado para una persona ───────────────
    if (error instanceof AppError) {
      request.log.warn({ err: error, reqId: request.id }, error.code);
      const body: ErrorBody = {
        error: { code: error.code, message: error.message, requestId: request.id },
      };
      return reply.status(error.statusCode).send(body);
    }

    // ── PostgreSQL: se registra completo, se responde opaco ────────────────
    // Un mensaje como 'duplicate key value violates unique constraint
    // "app_user_email_key"' revela el esquema y a veces el dato. Va al log.
    if (isDatabaseError(error)) {
      request.log.error({ err: error, reqId: request.id }, 'Error de base de datos');
      const body: ErrorBody = {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Error interno.',
          requestId: request.id,
        },
      };
      return reply.status(500).send(body);
    }

    // ── Rate limit y demás errores con statusCode de Fastify ───────────────
    if (isHttpError(error) && error.statusCode < 500) {
      request.log.warn({ err: error, reqId: request.id }, 'Solicitud rechazada');
      const body: ErrorBody = {
        error: {
          code: error.code ?? 'BAD_REQUEST',
          message: error.message,
          requestId: request.id,
        },
      };
      return reply.status(error.statusCode).send(body);
    }

    request.log.error({ err: error, reqId: request.id }, 'Error no controlado');
    const body: ErrorBody = {
      error: { code: 'INTERNAL_ERROR', message: 'Error interno.', requestId: request.id },
    };
    return reply.status(500).send(body);
  });
}
