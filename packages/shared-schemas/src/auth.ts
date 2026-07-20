import { z } from 'zod';

export const appRoleSchema = z.enum(['ADMIN', 'COORDINATOR']);
export type AppRole = z.infer<typeof appRoleSchema>;

export const publicUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  roles: z.array(appRoleSchema),
  lastLoginAt: z.string().datetime().nullable(),
  passwordChangedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const loginRequestSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authResponseSchema = z.object({ user: publicUserSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const sessionSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  idleExpiresAt: z.string().datetime(),
  absoluteExpiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionsResponseSchema = z.object({ sessions: z.array(sessionSchema) });

export const userIdParamsSchema = z.object({ userId: z.string().uuid() });
export const sessionIdParamsSchema = z.object({ sessionId: z.string().uuid() });

export const createUserRequestSchema = z.object({
  username: z.string().trim().min(3).max(64),
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(appRoleSchema).min(1),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    username: z.string().trim().min(3).max(64).optional(),
    email: z.string().trim().email().max(254).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Debe indicar al menos un cambio');
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const updateRolesRequestSchema = z.object({ roles: z.array(appRoleSchema).min(1) });
export type UpdateRolesRequest = z.infer<typeof updateRolesRequestSchema>;

export const userListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  active: z.enum(['true', 'false']).optional(),
});

export const usersResponseSchema = z.object({ users: z.array(publicUserSchema) });
export const temporaryPasswordResponseSchema = z.object({
  user: publicUserSchema,
  temporaryPassword: z.string(),
});
export type TemporaryPasswordResult = z.infer<typeof temporaryPasswordResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  actorUserId: z.string().uuid().nullable(),
  actorRoles: z.array(appRoleSchema).nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().uuid().nullable(),
  result: z.enum(['success', 'failure']),
  requestId: z.string().nullable(),
  reason: z.string().nullable(),
});
export const auditEventsResponseSchema = z.object({ events: z.array(auditEventSchema) });
