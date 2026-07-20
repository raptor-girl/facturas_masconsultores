import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  auditEventsResponseSchema,
  authResponseSchema,
  createUserRequestSchema,
  okResponseSchema,
  sessionsResponseSchema,
  temporaryPasswordResponseSchema,
  updateRolesRequestSchema,
  updateUserRequestSchema,
  userIdParamsSchema,
  userListQuerySchema,
  usersResponseSchema,
} from '@factuflow/shared-schemas';
import type { Env } from '../../../config/env.js';
import type { IdentityService } from '../../../application/auth/identity-service.js';
import {
  requestContext,
  requireAuthentication,
  requireCsrf,
  requirePasswordChanged,
  requireRole,
} from '../auth-guards.js';

interface AdminRouteOptions {
  readonly env: Env;
  readonly identity: IdentityService;
}

export function registerAdminUserRoutes(
  app: FastifyInstance,
  { env, identity }: AdminRouteOptions,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const admin = async (request: Parameters<typeof requireAuthentication>[0]) => {
    const auth = await requireAuthentication(request, identity, env);
    requirePasswordChanged(auth);
    requireRole(auth, 'ADMIN');
    return auth;
  };

  typed.route({
    method: 'GET',
    url: '/admin/users',
    schema: {
      tags: ['administración'],
      querystring: userListQuerySchema,
      response: { 200: usersResponseSchema },
    },
    handler: async (request) => {
      await admin(request);
      return {
        users: await identity.listUsers(
          request.query.search,
          request.query.active === undefined ? undefined : request.query.active === 'true',
        ),
      };
    },
  });

  typed.route({
    method: 'POST',
    url: '/admin/users',
    schema: {
      tags: ['administración'],
      body: createUserRequestSchema,
      response: { 201: temporaryPasswordResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await admin(request);
      requireCsrf(request, identity, auth);
      const result = await identity.createUser(auth, request.body, requestContext(request));
      return reply.status(201).send(result);
    },
  });

  typed.route({
    method: 'GET',
    url: '/admin/users/:userId',
    schema: {
      tags: ['administración'],
      params: userIdParamsSchema,
      response: { 200: authResponseSchema },
    },
    handler: async (request) => {
      await admin(request);
      return { user: await identity.getUser(request.params.userId) };
    },
  });

  typed.route({
    method: 'PATCH',
    url: '/admin/users/:userId',
    schema: {
      tags: ['administración'],
      params: userIdParamsSchema,
      body: updateUserRequestSchema,
      response: { 200: authResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      requireCsrf(request, identity, auth);
      return {
        user: await identity.updateUser(
          auth,
          request.params.userId,
          request.body,
          requestContext(request),
        ),
      };
    },
  });

  for (const active of [true, false]) {
    typed.route({
      method: 'POST',
      url: `/admin/users/:userId/${active ? 'activate' : 'deactivate'}`,
      schema: {
        tags: ['administración'],
        params: userIdParamsSchema,
        response: { 200: authResponseSchema },
      },
      handler: async (request) => {
        const auth = await admin(request);
        requireCsrf(request, identity, auth);
        return {
          user: await identity.setUserActive(
            auth,
            request.params.userId,
            active,
            requestContext(request),
          ),
        };
      },
    });
  }

  typed.route({
    method: 'POST',
    url: '/admin/users/:userId/reset-password',
    schema: {
      tags: ['administración'],
      params: userIdParamsSchema,
      response: { 200: temporaryPasswordResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      requireCsrf(request, identity, auth);
      return identity.resetPassword(auth, request.params.userId, requestContext(request));
    },
  });

  typed.route({
    method: 'GET',
    url: '/admin/users/:userId/sessions',
    schema: {
      tags: ['administración'],
      params: userIdParamsSchema,
      response: { 200: sessionsResponseSchema },
    },
    handler: async (request) => {
      await admin(request);
      return { sessions: await identity.listUserSessions(request.params.userId) };
    },
  });

  typed.route({
    method: 'POST',
    url: '/admin/users/:userId/sessions/revoke-all',
    schema: {
      tags: ['administración'],
      params: userIdParamsSchema,
      response: { 200: okResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      requireCsrf(request, identity, auth);
      await identity.revokeAllUserSessions(auth, request.params.userId, requestContext(request));
      return { ok: true as const };
    },
  });

  typed.route({
    method: 'PUT',
    url: '/admin/users/:userId/roles',
    schema: {
      tags: ['administración'],
      params: userIdParamsSchema,
      body: updateRolesRequestSchema,
      response: { 200: authResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      requireCsrf(request, identity, auth);
      return {
        user: await identity.updateRoles(
          auth,
          request.params.userId,
          request.body,
          requestContext(request),
        ),
      };
    },
  });

  typed.route({
    method: 'GET',
    url: '/admin/audit',
    schema: { tags: ['administración'], response: { 200: auditEventsResponseSchema } },
    handler: async (request) => {
      await admin(request);
      return { events: await identity.listAuthAudit() };
    },
  });
}
