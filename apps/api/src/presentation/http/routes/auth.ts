import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  authResponseSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  okResponseSchema,
  sessionIdParamsSchema,
  sessionsResponseSchema,
} from '@factuflow/shared-schemas';
import type { Env } from '../../../config/env.js';
import type { IdentityService } from '../../../application/auth/identity-service.js';
import {
  requestContext,
  requireAuthentication,
  requireCsrf,
  requirePasswordChanged,
} from '../auth-guards.js';

interface AuthRouteOptions {
  readonly env: Env;
  readonly identity: IdentityService;
}

function cookieOptions(env: Env, httpOnly: boolean) {
  return {
    httpOnly,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

function csrfCookieName(env: Env): string {
  return `${env.SESSION_COOKIE_NAME}_csrf`;
}

function clearAuthCookies(reply: FastifyReply, env: Env): void {
  reply.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions(env, true));
  reply.clearCookie(csrfCookieName(env), cookieOptions(env, false));
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { env, identity }: AuthRouteOptions,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'POST',
    url: '/auth/login',
    schema: {
      tags: ['autenticación'],
      body: loginRequestSchema,
      response: { 200: authResponseSchema },
    },
    config: { rateLimit: { max: env.LOGIN_MAX_ATTEMPTS * 4, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const result = await identity.login(
        request.body.identifier,
        request.body.password,
        requestContext(request),
      );
      reply.setCookie(env.SESSION_COOKIE_NAME, result.sessionToken, cookieOptions(env, true));
      reply.setCookie(csrfCookieName(env), result.csrfToken, cookieOptions(env, false));
      return { user: result.user };
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/logout',
    schema: { tags: ['autenticación'], response: { 200: okResponseSchema } },
    handler: async (request, reply) => {
      const auth = await requireAuthentication(request, identity, env);
      requireCsrf(request, identity, auth);
      await identity.logout(auth, requestContext(request));
      clearAuthCookies(reply, env);
      return { ok: true as const };
    },
  });

  typed.route({
    method: 'GET',
    url: '/auth/me',
    schema: { tags: ['autenticación'], response: { 200: authResponseSchema } },
    handler: async (request) => {
      const auth = await requireAuthentication(request, identity, env);
      return { user: auth.user };
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/change-password',
    schema: {
      tags: ['autenticación'],
      body: changePasswordRequestSchema,
      response: { 200: okResponseSchema },
    },
    handler: async (request) => {
      const auth = await requireAuthentication(request, identity, env);
      requireCsrf(request, identity, auth);
      await identity.changePassword(
        auth,
        request.body.currentPassword,
        request.body.newPassword,
        requestContext(request),
      );
      return { ok: true as const };
    },
  });

  typed.route({
    method: 'GET',
    url: '/auth/sessions',
    schema: { tags: ['autenticación'], response: { 200: sessionsResponseSchema } },
    handler: async (request) => {
      const auth = await requireAuthentication(request, identity, env);
      requirePasswordChanged(auth);
      return { sessions: await identity.listOwnSessions(auth) };
    },
  });

  typed.route({
    method: 'DELETE',
    url: '/auth/sessions/:sessionId',
    schema: {
      tags: ['autenticación'],
      params: sessionIdParamsSchema,
      response: { 200: okResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await requireAuthentication(request, identity, env);
      requirePasswordChanged(auth);
      requireCsrf(request, identity, auth);
      await identity.revokeOwnSession(auth, request.params.sessionId, requestContext(request));
      if (request.params.sessionId === auth.sessionId) clearAuthCookies(reply, env);
      return { ok: true as const };
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/sessions/revoke-others',
    schema: { tags: ['autenticación'], response: { 200: okResponseSchema } },
    handler: async (request) => {
      const auth = await requireAuthentication(request, identity, env);
      requirePasswordChanged(auth);
      requireCsrf(request, identity, auth);
      await identity.revokeOtherSessions(auth, requestContext(request));
      return { ok: true as const };
    },
  });
}
