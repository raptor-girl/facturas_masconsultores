import type { FastifyRequest } from 'fastify';
import type { Env } from '../../config/env.js';
import type {
  AuthenticatedSession,
  IdentityService,
  RequestContext,
} from '../../application/auth/identity-service.js';
import { AppError } from '../../application/errors.js';
import { minimizeIp } from '../../infrastructure/security/tokens.js';

export function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: request.id,
    ip: minimizeIp(request.ip),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
  };
}

export async function requireAuthentication(
  request: FastifyRequest,
  identity: IdentityService,
  env: Env,
): Promise<AuthenticatedSession> {
  const token = request.cookies[env.SESSION_COOKIE_NAME];
  if (!token) throw new AppError('UNAUTHENTICATED', 'Debe iniciar sesión.', 401);
  const auth = await identity.authenticate(token, requestContext(request));
  if (!auth) throw new AppError('UNAUTHENTICATED', 'La sesión no existe o expiró.', 401);
  return auth;
}

export function requireCsrf(
  request: FastifyRequest,
  identity: IdentityService,
  auth: AuthenticatedSession,
): void {
  const header = request.headers['x-csrf-token'];
  const token = typeof header === 'string' ? header : undefined;
  if (!identity.verifyCsrf(auth, token)) {
    throw new AppError('CSRF_INVALID', 'La protección CSRF rechazó la solicitud.', 403);
  }
}

export function requireRole(auth: AuthenticatedSession, role: 'ADMIN' | 'COORDINATOR'): void {
  if (!auth.user.roles.includes(role)) {
    throw new AppError('FORBIDDEN', 'No tiene permisos para esta operación.', 403);
  }
}

export function requirePasswordChanged(auth: AuthenticatedSession): void {
  if (auth.user.mustChangePassword) {
    throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Debe cambiar su contraseña temporal.', 403);
  }
}
