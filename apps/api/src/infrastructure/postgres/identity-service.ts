import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  AppRole,
  CreateUserRequest,
  PublicUser,
  Session,
  UpdateRolesRequest,
  UpdateUserRequest,
} from '@factuflow/shared-schemas';
import type { Env } from '../../config/env.js';
import { AppError } from '../../application/errors.js';
import type {
  AuditSummary,
  AuthenticatedSession,
  IdentityService,
  LoginResult,
  RequestContext,
  TemporaryPasswordResult,
} from '../../application/auth/identity-service.js';
import { PasswordPolicyError } from '../../domain/auth/password-policy.js';
import { PasswordService } from '../security/passwords.js';
import {
  createOpaqueToken,
  hashIdentifier,
  hashToken,
  tokenMatchesHash,
} from '../security/tokens.js';
import type { Database, JsonValue } from './schema.js';

type DbExecutor = Kysely<Database> | Transaction<Database>;

interface UserRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_count: number;
  failed_login_window_started_at: Date | null;
  locked_until: Date | null;
  last_login_at: Date | null;
  password_changed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date): string {
  return value.toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23505';
}

function safeUserChanges(user: PublicUser): JsonValue {
  return {
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles,
  };
}

export class PostgresIdentityService implements IdentityService {
  private readonly passwords: PasswordService;
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly env: Env,
  ) {
    this.passwords = new PasswordService(env);
  }

  async login(identifier: string, password: string, context: RequestContext): Promise<LoginResult> {
    const normalized = identifier.trim();
    const candidate = await this.findUserByIdentifier(this.db, normalized);
    const passwordValid = candidate
      ? await this.passwords.verify(candidate.password_hash, password)
      : await this.passwords.verify(await this.getDummyHash(), password);
    const sessionToken = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const now = new Date();

    const result = await this.db.transaction().execute(async (transaction) => {
      const user = candidate
        ? await transaction
            .selectFrom('app_user')
            .selectAll()
            .where('id', '=', candidate.id)
            .forUpdate()
            .executeTakeFirst()
        : undefined;

      if (!user) {
        await this.recordLoginAttempt(
          transaction,
          null,
          normalized,
          false,
          'INVALID_CREDENTIALS',
          context,
        );
        await this.audit(
          transaction,
          null,
          [],
          'AUTH_LOGIN_FAILED',
          'authentication',
          null,
          'failure',
          context,
          {
            reason: 'INVALID_CREDENTIALS',
            metadata: { identifierHash: hashIdentifier(normalized) },
          },
        );
        return null;
      }

      const roles = await this.rolesFor(transaction, user.id);
      // Si la contraseña cambió entre la lectura usada para Argon2 y el lock,
      // nunca se permite autenticar con el hash anterior.
      const currentPasswordValid = passwordValid && user.password_hash === candidate?.password_hash;
      if (!user.is_active) {
        await this.recordLoginAttempt(transaction, user.id, normalized, false, 'INACTIVE', context);
        await this.audit(
          transaction,
          user.id,
          roles,
          'AUTH_LOGIN_FAILED',
          'app_user',
          user.id,
          'failure',
          context,
          {
            reason: 'INACTIVE',
          },
        );
        return null;
      }

      if (user.locked_until && user.locked_until > now) {
        await this.recordLoginAttempt(transaction, user.id, normalized, false, 'LOCKED', context);
        await this.audit(
          transaction,
          user.id,
          roles,
          'AUTH_LOGIN_FAILED',
          'app_user',
          user.id,
          'failure',
          context,
          {
            reason: 'LOCKED',
          },
        );
        return null;
      }

      if (!currentPasswordValid) {
        const windowStart = user.failed_login_window_started_at;
        const windowExpired =
          !windowStart ||
          now.getTime() - windowStart.getTime() > this.env.LOGIN_ATTEMPT_WINDOW_MINUTES * 60_000;
        const failedCount = windowExpired ? 1 : user.failed_login_count + 1;
        const lockedUntil =
          failedCount >= this.env.LOGIN_MAX_ATTEMPTS
            ? new Date(now.getTime() + this.env.LOGIN_LOCK_MINUTES * 60_000)
            : null;

        await transaction
          .updateTable('app_user')
          .set({
            failed_login_count: failedCount,
            failed_login_window_started_at: windowExpired ? now : windowStart,
            locked_until: lockedUntil,
          })
          .where('id', '=', user.id)
          .execute();
        await this.recordLoginAttempt(
          transaction,
          user.id,
          normalized,
          false,
          'INVALID_CREDENTIALS',
          context,
        );
        await this.audit(
          transaction,
          user.id,
          roles,
          'AUTH_LOGIN_FAILED',
          'app_user',
          user.id,
          'failure',
          context,
          {
            reason: 'INVALID_CREDENTIALS',
          },
        );
        if (lockedUntil) {
          await this.audit(
            transaction,
            user.id,
            roles,
            'AUTH_ACCOUNT_LOCKED',
            'app_user',
            user.id,
            'success',
            context,
            {
              metadata: { lockedUntil: iso(lockedUntil) },
            },
          );
        }
        return null;
      }

      if (user.locked_until) {
        await this.audit(
          transaction,
          user.id,
          roles,
          'AUTH_ACCOUNT_UNLOCKED',
          'app_user',
          user.id,
          'success',
          context,
        );
      }

      const absoluteExpiresAt = new Date(
        now.getTime() + this.env.SESSION_ABSOLUTE_MINUTES * 60_000,
      );
      const idleExpiresAt = new Date(
        Math.min(
          now.getTime() + this.env.SESSION_IDLE_MINUTES * 60_000,
          absoluteExpiresAt.getTime(),
        ),
      );
      await transaction
        .updateTable('app_user')
        .set({
          failed_login_count: 0,
          failed_login_window_started_at: null,
          locked_until: null,
          last_login_at: now,
        })
        .where('id', '=', user.id)
        .execute();
      await transaction
        .insertInto('app_session')
        .values({
          app_user_id: user.id,
          token_hash: hashToken(sessionToken),
          csrf_token_hash: hashToken(csrfToken),
          last_seen_at: now,
          idle_expires_at: idleExpiresAt,
          absolute_expires_at: absoluteExpiresAt,
          revoked_at: null,
          revoked_reason: null,
          ip: context.ip,
          user_agent: context.userAgent,
        })
        .execute();
      await this.recordLoginAttempt(transaction, user.id, normalized, true, null, context);
      await this.audit(
        transaction,
        user.id,
        roles,
        'AUTH_LOGIN_SUCCEEDED',
        'app_user',
        user.id,
        'success',
        context,
      );
      return this.toPublicUser(transaction, { ...user, last_login_at: now }, roles);
    });

    if (!result) throw new AppError('INVALID_CREDENTIALS', 'Credenciales inválidas.', 401);
    return { user: result, sessionToken, csrfToken };
  }

  async authenticate(
    sessionToken: string,
    context: RequestContext,
  ): Promise<AuthenticatedSession | null> {
    if (!sessionToken) return null;
    const tokenHash = hashToken(sessionToken);
    const now = new Date();

    return this.db.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom('app_session')
        .innerJoin('app_user', 'app_user.id', 'app_session.app_user_id')
        .select([
          'app_session.id as session_id',
          'app_session.csrf_token_hash',
          'app_session.last_seen_at',
          'app_session.idle_expires_at',
          'app_session.absolute_expires_at',
          'app_session.revoked_at',
          'app_user.id',
          'app_user.username',
          'app_user.email',
          'app_user.display_name',
          'app_user.password_hash',
          'app_user.is_active',
          'app_user.must_change_password',
          'app_user.failed_login_count',
          'app_user.failed_login_window_started_at',
          'app_user.locked_until',
          'app_user.last_login_at',
          'app_user.password_changed_at',
          'app_user.created_at',
          'app_user.updated_at',
        ])
        .where('app_session.token_hash', '=', tokenHash)
        .forUpdate('app_session')
        .executeTakeFirst();

      if (!session || session.revoked_at || !session.is_active) return null;
      const roles = await this.rolesFor(transaction, session.id);
      if (session.idle_expires_at <= now || session.absolute_expires_at <= now) {
        await transaction
          .updateTable('app_session')
          .set({ revoked_at: now, revoked_reason: 'EXPIRED' })
          .where('id', '=', session.session_id)
          .execute();
        await this.audit(
          transaction,
          session.id,
          roles,
          'AUTH_SESSION_EXPIRED',
          'app_session',
          session.session_id,
          'success',
          context,
        );
        return null;
      }

      if (
        now.getTime() - session.last_seen_at.getTime() >=
        this.env.SESSION_ACTIVITY_UPDATE_MINUTES * 60_000
      ) {
        const idleExpiresAt = new Date(
          Math.min(
            now.getTime() + this.env.SESSION_IDLE_MINUTES * 60_000,
            session.absolute_expires_at.getTime(),
          ),
        );
        await transaction
          .updateTable('app_session')
          .set({ last_seen_at: now, idle_expires_at: idleExpiresAt })
          .where('id', '=', session.session_id)
          .execute();
      }

      return {
        user: await this.toPublicUser(transaction, session, roles),
        sessionId: session.session_id,
        csrfTokenHash: session.csrf_token_hash,
      };
    });
  }

  verifyCsrf(auth: AuthenticatedSession, csrfToken: string | undefined): boolean {
    return Boolean(csrfToken && tokenMatchesHash(csrfToken, auth.csrfTokenHash));
  }

  async logout(auth: AuthenticatedSession, context: RequestContext): Promise<void> {
    await this.revokeSessions(auth, [auth.sessionId], 'LOGOUT', 'AUTH_LOGOUT', context);
  }

  async changePassword(
    auth: AuthenticatedSession,
    currentPassword: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void> {
    const user = await this.findUserById(this.db, auth.user.id);
    if (!user || !(await this.passwords.verify(user.password_hash, currentPassword))) {
      throw new AppError('INVALID_CURRENT_PASSWORD', 'La contraseña actual no es correcta.', 400);
    }
    if (await this.passwords.verify(user.password_hash, newPassword)) {
      throw new AppError('PASSWORD_REUSED', 'La nueva contraseña debe ser distinta.', 400);
    }
    let newHash: string;
    try {
      newHash = await this.passwords.hash(newPassword, user);
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        throw new AppError('PASSWORD_POLICY', error.message, 400);
      }
      throw error;
    }

    await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      await transaction
        .updateTable('app_user')
        .set({ password_hash: newHash, must_change_password: false, password_changed_at: now })
        .where('id', '=', auth.user.id)
        .execute();
      await transaction
        .updateTable('app_session')
        .set({ revoked_at: now, revoked_reason: 'PASSWORD_CHANGED' })
        .where('app_user_id', '=', auth.user.id)
        .where('id', '!=', auth.sessionId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.audit(
        transaction,
        auth.user.id,
        auth.user.roles,
        'AUTH_PASSWORD_CHANGED',
        'app_user',
        auth.user.id,
        'success',
        context,
      );
    });
  }

  async listOwnSessions(auth: AuthenticatedSession): Promise<Session[]> {
    return this.sessionsFor(auth.user.id, auth.sessionId);
  }

  async revokeOwnSession(
    auth: AuthenticatedSession,
    sessionId: string,
    context: RequestContext,
  ): Promise<void> {
    await this.revokeSessions(
      auth,
      [sessionId],
      'SESSION_REVOKED',
      'AUTH_SESSION_REVOKED',
      context,
      auth.user.id,
    );
  }

  async revokeOtherSessions(auth: AuthenticatedSession, context: RequestContext): Promise<void> {
    const ids = await this.db
      .selectFrom('app_session')
      .select('id')
      .where('app_user_id', '=', auth.user.id)
      .where('id', '!=', auth.sessionId)
      .where('revoked_at', 'is', null)
      .execute();
    await this.revokeSessions(
      auth,
      ids.map((row) => row.id),
      'REVOKE_OTHERS',
      'AUTH_SESSION_REVOKED',
      context,
      auth.user.id,
    );
  }

  async listUsers(search?: string, active?: boolean): Promise<PublicUser[]> {
    let query = this.db.selectFrom('app_user').selectAll().orderBy('display_name');
    if (search) {
      const term = `%${search}%`;
      query = query.where((expression) =>
        expression.or([
          expression('username', 'ilike', term),
          expression('email', 'ilike', term),
          expression('display_name', 'ilike', term),
        ]),
      );
    }
    if (active !== undefined) query = query.where('is_active', '=', active);
    const users = await query.execute();
    return Promise.all(users.map(async (user) => this.toPublicUser(this.db, user)));
  }

  async getUser(userId: string): Promise<PublicUser> {
    const user = await this.findUserById(this.db, userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 'El usuario no existe.', 404);
    return this.toPublicUser(this.db, user);
  }

  async createUser(
    actor: AuthenticatedSession,
    input: CreateUserRequest,
    context: RequestContext,
  ): Promise<TemporaryPasswordResult> {
    const temporaryPassword = this.passwords.generateTemporary(input);
    const passwordHash = await this.passwords.hash(temporaryPassword, input);
    try {
      const user = await this.db.transaction().execute(async (transaction) => {
        const created = await transaction
          .insertInto('app_user')
          .values({
            username: input.username,
            email: input.email,
            display_name: input.displayName,
            password_hash: passwordHash,
            must_change_password: true,
            is_active: true,
            failed_login_count: 0,
            failed_login_window_started_at: null,
            locked_until: null,
            last_login_at: null,
            password_changed_at: null,
            created_by: actor.user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('app_user_role')
          .values(input.roles.map((role) => ({ app_user_id: created.id, role_code: role })))
          .execute();
        const publicUser = await this.toPublicUser(transaction, created, input.roles);
        await this.audit(
          transaction,
          actor.user.id,
          actor.user.roles,
          'USER_CREATED',
          'app_user',
          created.id,
          'success',
          context,
          { changesAfter: safeUserChanges(publicUser) },
        );
        return publicUser;
      });
      return { user, temporaryPassword };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError('USER_DUPLICATE', 'Username o correo ya existe.', 409);
      throw error;
    }
  }

  async updateUser(
    actor: AuthenticatedSession,
    userId: string,
    input: UpdateUserRequest,
    context: RequestContext,
  ): Promise<PublicUser> {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const before = await this.requireUser(transaction, userId);
        const beforePublic = await this.toPublicUser(transaction, before);
        const updated = await transaction
          .updateTable('app_user')
          .set({
            ...(input.username === undefined ? {} : { username: input.username }),
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
          })
          .where('id', '=', userId)
          .returningAll()
          .executeTakeFirstOrThrow();
        const after = await this.toPublicUser(transaction, updated);
        await this.audit(
          transaction,
          actor.user.id,
          actor.user.roles,
          'USER_UPDATED',
          'app_user',
          userId,
          'success',
          context,
          {
            changesBefore: safeUserChanges(beforePublic),
            changesAfter: safeUserChanges(after),
          },
        );
        return after;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError('USER_DUPLICATE', 'Username o correo ya existe.', 409);
      throw error;
    }
  }

  async setUserActive(
    actor: AuthenticatedSession,
    userId: string,
    active: boolean,
    context: RequestContext,
  ): Promise<PublicUser> {
    return this.db.transaction().execute(async (transaction) => {
      await this.lockAdminInvariant(transaction);
      const before = await this.requireUser(transaction, userId);
      const beforePublic = await this.toPublicUser(transaction, before);
      if (!active && before.is_active && beforePublic.roles.includes('ADMIN')) {
        await this.assertAnotherActiveAdmin(transaction, userId);
      }
      const updated = await transaction
        .updateTable('app_user')
        .set({ is_active: active })
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (!active) {
        await transaction
          .updateTable('app_session')
          .set({ revoked_at: new Date(), revoked_reason: 'USER_DEACTIVATED' })
          .where('app_user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .execute();
      }
      const after = await this.toPublicUser(transaction, updated, beforePublic.roles);
      await this.audit(
        transaction,
        actor.user.id,
        actor.user.roles,
        active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
        'app_user',
        userId,
        'success',
        context,
        { changesBefore: safeUserChanges(beforePublic), changesAfter: safeUserChanges(after) },
      );
      return after;
    });
  }

  async resetPassword(
    actor: AuthenticatedSession,
    userId: string,
    context: RequestContext,
  ): Promise<TemporaryPasswordResult> {
    const target = await this.requireUser(this.db, userId);
    const temporaryPassword = this.passwords.generateTemporary(target);
    const passwordHash = await this.passwords.hash(temporaryPassword, target);
    const user = await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const updated = await transaction
        .updateTable('app_user')
        .set({ password_hash: passwordHash, must_change_password: true, password_changed_at: null })
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('app_session')
        .set({ revoked_at: now, revoked_reason: 'PASSWORD_RESET' })
        .where('app_user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.audit(
        transaction,
        actor.user.id,
        actor.user.roles,
        'AUTH_PASSWORD_RESET',
        'app_user',
        userId,
        'success',
        context,
      );
      return this.toPublicUser(transaction, updated);
    });
    return { user, temporaryPassword };
  }

  async listUserSessions(userId: string): Promise<Session[]> {
    await this.getUser(userId);
    return this.sessionsFor(userId, null);
  }

  async revokeAllUserSessions(
    actor: AuthenticatedSession,
    userId: string,
    context: RequestContext,
  ): Promise<void> {
    await this.getUser(userId);
    const ids = await this.db
      .selectFrom('app_session')
      .select('id')
      .where('app_user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    await this.revokeSessions(
      actor,
      ids.map((row) => row.id),
      'ADMIN_REVOKED',
      'USER_SESSIONS_REVOKED',
      context,
      userId,
    );
  }

  async updateRoles(
    actor: AuthenticatedSession,
    userId: string,
    input: UpdateRolesRequest,
    context: RequestContext,
  ): Promise<PublicUser> {
    const uniqueRoles = [...new Set(input.roles)];
    return this.db.transaction().execute(async (transaction) => {
      await this.lockAdminInvariant(transaction);
      const user = await this.requireUser(transaction, userId);
      const before = await this.toPublicUser(transaction, user);
      if (user.is_active && before.roles.includes('ADMIN') && !uniqueRoles.includes('ADMIN')) {
        await this.assertAnotherActiveAdmin(transaction, userId);
      }
      await transaction.deleteFrom('app_user_role').where('app_user_id', '=', userId).execute();
      await transaction
        .insertInto('app_user_role')
        .values(uniqueRoles.map((role) => ({ app_user_id: userId, role_code: role })))
        .execute();
      const after = await this.toPublicUser(transaction, user, uniqueRoles);
      await this.audit(
        transaction,
        actor.user.id,
        actor.user.roles,
        'USER_ROLES_CHANGED',
        'app_user',
        userId,
        'success',
        context,
        { changesBefore: safeUserChanges(before), changesAfter: safeUserChanges(after) },
      );
      return after;
    });
  }

  async listAuthAudit(): Promise<AuditSummary[]> {
    const rows = await this.db
      .selectFrom('audit_event')
      .selectAll()
      .where((expression) =>
        expression.or([
          expression('action', 'like', 'AUTH_%'),
          expression('action', 'like', 'USER_%'),
        ]),
      )
      .orderBy('occurred_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      occurredAt: iso(row.occurred_at),
      actorUserId: row.app_user_id,
      actorRoles: row.actor_roles as AppRole[] | null,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      result: row.result,
      requestId: row.request_id,
      reason: row.reason,
    }));
  }

  async bootstrapAdmin(input: {
    username: string;
    email: string;
    displayName: string;
  }): Promise<TemporaryPasswordResult> {
    const existing = await this.db
      .selectFrom('app_user')
      .innerJoin('app_user_role', 'app_user_role.app_user_id', 'app_user.id')
      .select('app_user.id')
      .where('app_user.is_active', '=', true)
      .where('app_user_role.role_code', '=', 'ADMIN')
      .executeTakeFirst();
    if (existing) throw new AppError('ADMIN_EXISTS', 'Ya existe un ADMIN activo.', 409);

    const temporaryPassword = this.passwords.generateTemporary(input);
    const passwordHash = await this.passwords.hash(temporaryPassword, input);
    try {
      const user = await this.db.transaction().execute(async (transaction) => {
        await this.lockAdminInvariant(transaction);
        const activeAdmin = await transaction
          .selectFrom('app_user')
          .innerJoin('app_user_role', 'app_user_role.app_user_id', 'app_user.id')
          .select('app_user.id')
          .where('app_user.is_active', '=', true)
          .where('app_user_role.role_code', '=', 'ADMIN')
          .executeTakeFirst();
        if (activeAdmin) {
          throw new AppError('ADMIN_EXISTS', 'Ya existe un ADMIN activo.', 409);
        }
        const created = await transaction
          .insertInto('app_user')
          .values({
            username: input.username,
            email: input.email,
            display_name: input.displayName,
            password_hash: passwordHash,
            must_change_password: true,
            is_active: true,
            failed_login_count: 0,
            failed_login_window_started_at: null,
            locked_until: null,
            last_login_at: null,
            password_changed_at: null,
            created_by: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('app_user_role')
          .values({ app_user_id: created.id, role_code: 'ADMIN' })
          .execute();
        const publicUser = await this.toPublicUser(transaction, created, ['ADMIN']);
        await this.audit(
          transaction,
          null,
          [],
          'USER_CREATED',
          'app_user',
          created.id,
          'success',
          {
            requestId: 'bootstrap-admin',
            ip: null,
            userAgent: 'user:bootstrap-admin',
          },
          { reason: 'BOOTSTRAP', changesAfter: safeUserChanges(publicUser) },
        );
        return publicUser;
      });
      return { user, temporaryPassword };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError('USER_DUPLICATE', 'Username o correo ya existe.', 409);
      throw error;
    }
  }

  private async findUserByIdentifier(
    executor: DbExecutor,
    identifier: string,
  ): Promise<UserRow | undefined> {
    return executor
      .selectFrom('app_user')
      .selectAll()
      .where((expression) =>
        expression.or([
          expression('username', '=', identifier),
          expression('email', '=', identifier),
        ]),
      )
      .executeTakeFirst();
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash('Dummy-only-42!NeverUsed', {
      username: 'dummy-user',
      email: 'dummy@example.invalid',
    });
    return this.dummyHash;
  }

  private async findUserById(executor: DbExecutor, userId: string): Promise<UserRow | undefined> {
    return executor.selectFrom('app_user').selectAll().where('id', '=', userId).executeTakeFirst();
  }

  private async requireUser(executor: DbExecutor, userId: string): Promise<UserRow> {
    const user = await this.findUserById(executor, userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 'El usuario no existe.', 404);
    return user;
  }

  private async rolesFor(executor: DbExecutor, userId: string): Promise<AppRole[]> {
    const rows = await executor
      .selectFrom('app_user_role')
      .select('role_code')
      .where('app_user_id', '=', userId)
      .orderBy('role_code')
      .execute();
    return rows.map((row) => row.role_code as AppRole);
  }

  private async toPublicUser(
    executor: DbExecutor,
    user: UserRow,
    knownRoles?: readonly AppRole[],
  ): Promise<PublicUser> {
    const roles = knownRoles ? [...knownRoles] : await this.rolesFor(executor, user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      isActive: user.is_active,
      mustChangePassword: user.must_change_password,
      roles,
      lastLoginAt: user.last_login_at ? iso(user.last_login_at) : null,
      passwordChangedAt: user.password_changed_at ? iso(user.password_changed_at) : null,
      createdAt: iso(user.created_at),
      updatedAt: iso(user.updated_at),
    };
  }

  private async sessionsFor(userId: string, currentSessionId: string | null): Promise<Session[]> {
    const rows = await this.db
      .selectFrom('app_session')
      .select([
        'id',
        'created_at',
        'last_seen_at',
        'idle_expires_at',
        'absolute_expires_at',
        'revoked_at',
        'ip',
        'user_agent',
      ])
      .where('app_user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('idle_expires_at', '>', new Date())
      .where('absolute_expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_seen_at),
      idleExpiresAt: iso(row.idle_expires_at),
      absoluteExpiresAt: iso(row.absolute_expires_at),
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
      ip: row.ip,
      userAgent: row.user_agent,
      current: row.id === currentSessionId,
    }));
  }

  private async revokeSessions(
    actor: AuthenticatedSession,
    sessionIds: readonly string[],
    reason: 'LOGOUT' | 'SESSION_REVOKED' | 'REVOKE_OTHERS' | 'ADMIN_REVOKED',
    action: string,
    context: RequestContext,
    targetUserId = actor.user.id,
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('app_session')
        .set({ revoked_at: new Date(), revoked_reason: reason })
        .where('id', 'in', [...sessionIds])
        .where('app_user_id', '=', targetUserId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.audit(
        transaction,
        actor.user.id,
        actor.user.roles,
        action,
        'app_session',
        sessionIds.length === 1 ? (sessionIds[0] ?? null) : null,
        'success',
        context,
        { metadata: { count: sessionIds.length, targetUserId } },
      );
    });
  }

  private async recordLoginAttempt(
    transaction: Transaction<Database>,
    userId: string | null,
    identifier: string,
    succeeded: boolean,
    failureReason: 'INVALID_CREDENTIALS' | 'INACTIVE' | 'LOCKED' | null,
    context: RequestContext,
  ): Promise<void> {
    await transaction
      .insertInto('login_attempt')
      .values({
        identifier_hash: hashIdentifier(identifier),
        app_user_id: userId,
        succeeded,
        failure_reason: failureReason,
        request_id: context.requestId,
        ip: context.ip,
        user_agent: context.userAgent,
      })
      .execute();
  }

  private async audit(
    transaction: Transaction<Database>,
    actorUserId: string | null,
    actorRoles: readonly AppRole[],
    action: string,
    entity: string,
    entityId: string | null,
    result: 'success' | 'failure',
    context: RequestContext,
    options: {
      reason?: string;
      changesBefore?: JsonValue;
      changesAfter?: JsonValue;
      metadata?: JsonValue;
    } = {},
  ): Promise<void> {
    await transaction
      .insertInto('audit_event')
      .values({
        app_user_id: actorUserId,
        actor_roles: [...actorRoles],
        action,
        entity,
        entity_id: entityId,
        result,
        request_id: context.requestId,
        ip: context.ip,
        user_agent: context.userAgent,
        reason: options.reason ?? null,
        changes_before: options.changesBefore ?? null,
        changes_after: options.changesAfter ?? null,
        metadata: options.metadata ?? null,
      })
      .execute();
  }

  private async lockAdminInvariant(transaction: Transaction<Database>): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(62002)`.execute(transaction);
  }

  private async assertAnotherActiveAdmin(
    transaction: Transaction<Database>,
    excludedUserId: string,
  ): Promise<void> {
    const result = await transaction
      .selectFrom('app_user')
      .innerJoin('app_user_role', 'app_user_role.app_user_id', 'app_user.id')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('app_user.is_active', '=', true)
      .where('app_user.id', '!=', excludedUserId)
      .where('app_user_role.role_code', '=', 'ADMIN')
      .executeTakeFirstOrThrow();
    if (Number(result.count) < 1) {
      throw new AppError(
        'LAST_ACTIVE_ADMIN',
        'No se puede dejar el sistema sin un ADMIN activo.',
        409,
      );
    }
  }
}
