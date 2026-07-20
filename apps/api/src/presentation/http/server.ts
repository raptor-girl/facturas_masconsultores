import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../infrastructure/postgres/schema.js';
import type { Env } from '../../config/env.js';
import { registerHealthRoute } from './routes/health.js';
import { registerErrorHandler } from './errors.js';
import { PostgresIdentityService } from '../../infrastructure/postgres/identity-service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { AppError } from '../../application/errors.js';

export interface BuildServerOptions {
  readonly env: Env;
  readonly db: Kysely<Database>;
  readonly version: string;
}

/**
 * Construye la instancia de Fastify.
 *
 * Se exporta como funcion (y no como singleton) para que las pruebas levanten
 * un servidor con sus propias dependencias, sin variables globales ni puertos
 * reales.
 *
 * OpenAPI se genera desde los esquemas Zod de las rutas (R-15): el contrato se
 * deriva del codigo en vez de mantenerse a mano, que es como los contratos
 * escritos a mano terminan mintiendo.
 */
export async function buildServer({
  env,
  db,
  version,
}: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Logs seguros: estas cabeceras llevan credenciales. Se redactan en el
      // logger, no en cada punto de llamada, porque olvidarse una vez basta.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.token',
        ],
        censor: '[REDACTADO]',
      },
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url,
          // Sin cabeceras completas ni cuerpo: aqui pasan RUT y correos.
          remoteAddress: request.ip,
        }),
      },
    },
    // Request ID: correlaciona log, respuesta de error y audit_event.request_id.
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCookie);

  // Cabeceras de seguridad. CSP se deja en el default de helmet: el frontend
  // real todavia no existe y afinarla ahora seria adivinar.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: env.NODE_ENV === 'production',
  });

  // CORS con origenes EXPLICITOS. Nunca '*': este API usara cookies de sesion
  // en la Fase 2, y comodin + credenciales es una puerta abierta.
  await app.register(fastifyCors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  await app.register(fastifyRateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // /health lo consultan Docker y el orquestador cada pocos segundos:
    // limitarlo provocaria justo el falso negativo que debe evitar.
    allowList: (request) => request.url === '/health',
  });

  // CORS controla qué respuestas puede leer otro origen; no reemplaza CSRF.
  // Esta verificación adicional rechaza escrituras que declaran un Origin no
  // autorizado antes de alcanzar cualquier operación de dominio.
  app.addHook('onRequest', (request, _reply, done) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      done();
      return;
    }
    const origin = request.headers.origin;
    if (origin && !env.CORS_ORIGINS.includes(origin)) {
      done(new AppError('ORIGIN_NOT_ALLOWED', 'Origen no autorizado.', 403));
      return;
    }
    done();
  });

  // Devuelve el request id al cliente: sin esto, un usuario que reporta un
  // error no tiene como referenciarlo y hay que adivinar en los logs.
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  registerErrorHandler(app);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'FactuFlow API',
        description: 'FactuFlow. Fase 2: autenticación, usuarios, roles y sesiones.',
        version,
      },
      tags: [
        { name: 'sistema', description: 'Estado y diagnóstico' },
        { name: 'autenticación', description: 'Sesión y cuenta propia' },
        { name: 'administración', description: 'Usuarios, roles, sesiones y auditoría' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  registerHealthRoute(app, { db, version });
  const identity = new PostgresIdentityService(db, env);
  registerAuthRoutes(app, { env, identity });
  registerAdminUserRoutes(app, { env, identity });

  return app;
}
