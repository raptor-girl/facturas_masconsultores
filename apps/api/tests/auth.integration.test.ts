import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import type { Kysely } from 'kysely';
import { startTestDatabase, connect, type TestDatabase } from './setup/postgres.js';
import { createDb } from '../src/infrastructure/postgres/db.js';
import type { Database } from '../src/infrastructure/postgres/schema.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { buildServer } from '../src/presentation/http/server.js';
import { PostgresIdentityService } from '../src/infrastructure/postgres/identity-service.js';
import { hashToken } from '../src/infrastructure/security/tokens.js';
import { PasswordService } from '../src/infrastructure/security/passwords.js';

interface Jar {
  cookie: string;
  csrf: string;
  sessionToken: string;
}

interface ApiErrorBody {
  error: { code: string; message: string; requestId: string };
}

describe('autenticación, usuarios, roles, sesiones y trazabilidad', () => {
  let database: TestDatabase;
  let db: Kysely<Database>;
  let env: Env;
  let app: FastifyInstance;
  let adminTemporary = '';
  let adminId = '';
  let adminJar: Jar;

  const login = async (identifier: string, password: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier, password },
    });
    if (response.statusCode !== 200) return { response, jar: undefined };
    const session = response.cookies.find((cookie) => cookie.name === env.SESSION_COOKIE_NAME);
    const csrf = response.cookies.find(
      (cookie) => cookie.name === `${env.SESSION_COOKIE_NAME}_csrf`,
    );
    if (!session || !csrf) throw new Error('Login sin cookies esperadas');
    return {
      response,
      jar: {
        cookie: `${session.name}=${session.value}; ${csrf.name}=${csrf.value}`,
        csrf: csrf.value,
        sessionToken: session.value,
      },
    };
  };

  const authenticated = (
    jar: Jar,
    options: {
      method: NonNullable<InjectOptions['method']>;
      url: string;
      payload?: NonNullable<InjectOptions['payload']>;
    },
  ): Promise<InjectResponse> =>
    app.inject({
      ...options,
      headers: { cookie: jar.cookie, 'x-csrf-token': jar.csrf },
    });

  beforeAll(async () => {
    database = await startTestDatabase();
    env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL_APP: database.appUri,
      PASSWORD_HASH_MEMORY_KIB: '8192',
      PASSWORD_HASH_TIME_COST: '2',
    });
    db = createDb({ connectionString: env.DATABASE_URL_APP });
    app = await buildServer({ env, db, version: '0.2.0-test' });
    await app.ready();

    const bootstrap = await new PostgresIdentityService(db, env).bootstrapAdmin({
      username: 'admin.phase2',
      email: 'admin.phase2@example.invalid',
      displayName: 'Admin de prueba',
    });
    adminTemporary = bootstrap.temporaryPassword;
    adminId = bootstrap.user.id;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await database.stop();
  });

  it('bootstrap crea sólo hash, ADMIN y cambio obligatorio', async () => {
    const row = await db
      .selectFrom('app_user')
      .select(['password_hash', 'must_change_password'])
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    const roles = await db
      .selectFrom('app_user_role')
      .select('role_code')
      .where('app_user_id', '=', adminId)
      .execute();

    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(adminTemporary);
    expect(row.must_change_password).toBe(true);
    expect(roles.map((role) => role.role_code)).toEqual(['ADMIN']);
  });

  it('login exitoso usa cookies, CSRF y persiste únicamente hashes', async () => {
    const result = await login('ADMIN.PHASE2', adminTemporary);
    expect(result.response.statusCode).toBe(200);
    adminJar = result.jar!;

    const sessionCookie = result.response.cookies.find(
      (cookie) => cookie.name === env.SESSION_COOKIE_NAME,
    );
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(sessionCookie?.value).not.toContain(adminId);

    const stored = await db
      .selectFrom('app_session')
      .select(['token_hash', 'csrf_token_hash'])
      .where('app_user_id', '=', adminId)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).toBe(hashToken(adminJar.sessionToken));
    expect(stored.token_hash).not.toBe(adminJar.sessionToken);
    expect(stored.csrf_token_hash).toBe(hashToken(adminJar.csrf));

    const csrfRejected = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: adminJar.cookie },
    });
    expect(csrfRejected.statusCode).toBe(403);

    const originRejected = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://untrusted.example.invalid' },
      payload: { identifier: 'admin.phase2', password: adminTemporary },
    });
    expect(originRejected.statusCode).toBe(403);

    const productionEnv = loadEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      DATABASE_URL_APP: database.appUri,
    });
    const productionApp = await buildServer({
      env: productionEnv,
      db,
      version: '0.2.0-production-cookie-test',
    });
    await productionApp.ready();
    try {
      const productionLogin = await productionApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { identifier: 'admin.phase2', password: adminTemporary },
      });
      expect(
        productionLogin.cookies.find((cookie) => cookie.name === env.SESSION_COOKIE_NAME)?.secure,
      ).toBe(true);
    } finally {
      await productionApp.close();
    }
  });

  it('login incorrecto e inexistente entregan la misma respuesta genérica y auditan', async () => {
    const wrong = await login('admin.phase2', 'Wrong-password-42!');
    const missing = await login('nobody@example.invalid', 'Wrong-password-42!');
    expect(wrong.response.statusCode).toBe(401);
    expect(missing.response.statusCode).toBe(401);
    const wrongBody = wrong.response.json<ApiErrorBody>();
    const missingBody = missing.response.json<ApiErrorBody>();
    expect({ code: wrongBody.error.code, message: wrongBody.error.message }).toEqual({
      code: missingBody.error.code,
      message: missingBody.error.message,
    });

    const attempts = await db.selectFrom('login_attempt').selectAll().execute();
    expect(attempts.some((attempt) => attempt.app_user_id === null)).toBe(true);
    expect(JSON.stringify(attempts)).not.toContain('Wrong-password-42!');
  });

  it('cambio obligatorio bloquea ADMIN, cambia contraseña y revoca las demás sesiones', async () => {
    const forbidden = await authenticated(adminJar, { method: 'GET', url: '/admin/users' });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<ApiErrorBody>().error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const secondLogin = await login('admin.phase2', adminTemporary);
    expect(secondLogin.response.statusCode).toBe(200);

    const changed = await authenticated(adminJar, {
      method: 'POST',
      url: '/auth/change-password',
      payload: {
        currentPassword: adminTemporary,
        newPassword: 'Admin-New-Passphrase-42!',
      },
    });
    expect(changed.statusCode).toBe(200);
    const me = await authenticated(adminJar, { method: 'GET', url: '/auth/me' });
    expect(me.json<{ user: { mustChangePassword: boolean } }>().user.mustChangePassword).toBe(
      false,
    );
    const revoked = await authenticated(secondLogin.jar!, { method: 'GET', url: '/auth/me' });
    expect(revoked.statusCode).toBe(401);
  });

  it('ADMIN crea usuarios sin exponer hash y detecta duplicados', async () => {
    const created = await authenticated(adminJar, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'coordinator.test',
        email: 'coordinator.test@example.invalid',
        displayName: 'Coordinador de prueba',
        roles: ['COORDINATOR'],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      user: { id: string; password_hash?: string; roles: string[] };
      temporaryPassword: string;
    }>();
    expect(body.user.password_hash).toBeUndefined();
    expect(body.user.roles).toEqual(['COORDINATOR']);
    expect(JSON.stringify(body.user)).not.toContain('password_hash');

    const duplicateUsername = await authenticated(adminJar, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'COORDINATOR.TEST',
        email: 'different@example.invalid',
        displayName: 'Duplicado',
        roles: ['COORDINATOR'],
      },
    });
    expect(duplicateUsername.statusCode).toBe(409);

    const duplicateEmail = await authenticated(adminJar, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'different.user',
        email: 'COORDINATOR.TEST@EXAMPLE.INVALID',
        displayName: 'Duplicado',
        roles: ['COORDINATOR'],
      },
    });
    expect(duplicateEmail.statusCode).toBe(409);

    const coordinator = await login('coordinator.test', body.temporaryPassword);
    expect(coordinator.response.statusCode).toBe(200);
    const changed = await authenticated(coordinator.jar!, {
      method: 'POST',
      url: '/auth/change-password',
      payload: {
        currentPassword: body.temporaryPassword,
        newPassword: 'Coordinator-New-Pass-42!',
      },
    });
    expect(changed.statusCode).toBe(200);
    const denied = await authenticated(coordinator.jar!, {
      method: 'GET',
      url: '/admin/users',
    });
    expect(denied.statusCode).toBe(403);
  });

  it('bloquea fuerza bruta y permite desbloqueo al terminar el plazo', async () => {
    const created = await authenticated(adminJar, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'locked.user',
        email: 'locked.user@example.invalid',
        displayName: 'Usuario bloqueado',
        roles: ['COORDINATOR'],
      },
    });
    const body = created.json<{ user: { id: string }; temporaryPassword: string }>();
    for (let count = 0; count < env.LOGIN_MAX_ATTEMPTS; count += 1) {
      const failed = await login('locked.user', 'Wrong-password-42!');
      expect(failed.response.statusCode).toBe(401);
    }
    const locked = await db
      .selectFrom('app_user')
      .select(['failed_login_count', 'locked_until'])
      .where('id', '=', body.user.id)
      .executeTakeFirstOrThrow();
    expect(locked.failed_login_count).toBe(env.LOGIN_MAX_ATTEMPTS);
    expect(locked.locked_until).not.toBeNull();
    expect((await login('locked.user', body.temporaryPassword)).response.statusCode).toBe(401);

    const owner = await connect(database.ownerUri);
    try {
      await owner.query(
        `UPDATE app_user SET locked_until = now() - interval '1 minute', failed_login_window_started_at = now() - interval '1 hour' WHERE id = $1`,
        [body.user.id],
      );
    } finally {
      await owner.end();
    }
    expect((await login('locked.user', body.temporaryPassword)).response.statusCode).toBe(200);
    const actions = await db
      .selectFrom('audit_event')
      .select('action')
      .where('app_user_id', '=', body.user.id)
      .execute();
    expect(actions.map((row) => row.action)).toContain('AUTH_ACCOUNT_LOCKED');
    expect(actions.map((row) => row.action)).toContain('AUTH_ACCOUNT_UNLOCKED');
  });

  it('protege al último ADMIN activo y rechaza roles arbitrarios o ausencia de rol', async () => {
    const deactivate = await authenticated(adminJar, {
      method: 'POST',
      url: `/admin/users/${adminId}/deactivate`,
    });
    expect(deactivate.statusCode).toBe(409);

    const removeRole = await authenticated(adminJar, {
      method: 'PUT',
      url: `/admin/users/${adminId}/roles`,
      payload: { roles: ['COORDINATOR'] },
    });
    expect(removeRole.statusCode).toBe(409);

    const arbitrary = await authenticated(adminJar, {
      method: 'PUT',
      url: `/admin/users/${adminId}/roles`,
      payload: { roles: ['SUPERADMIN'] },
    });
    expect(arbitrary.statusCode).toBe(400);
    const empty = await authenticated(adminJar, {
      method: 'PUT',
      url: `/admin/users/${adminId}/roles`,
      payload: { roles: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('desactivar usuario revoca sesiones e impide login', async () => {
    const user = await db
      .selectFrom('app_user')
      .select('id')
      .where('username', '=', 'coordinator.test')
      .executeTakeFirstOrThrow();
    const session = await login('coordinator.test', 'Coordinator-New-Pass-42!');
    expect(session.response.statusCode).toBe(200);
    const deactivated = await authenticated(adminJar, {
      method: 'POST',
      url: `/admin/users/${user.id}/deactivate`,
    });
    expect(deactivated.statusCode).toBe(200);
    expect((await authenticated(session.jar!, { method: 'GET', url: '/auth/me' })).statusCode).toBe(
      401,
    );
    expect((await login('coordinator.test', 'Coordinator-New-Pass-42!')).response.statusCode).toBe(
      401,
    );
  });

  it('activa, restablece, asigna roles permitidos y revoca todas las sesiones', async () => {
    const target = await db
      .selectFrom('app_user')
      .select('id')
      .where('username', '=', 'coordinator.test')
      .executeTakeFirstOrThrow();
    expect(
      (
        await authenticated(adminJar, {
          method: 'POST',
          url: `/admin/users/${target.id}/activate`,
        })
      ).statusCode,
    ).toBe(200);

    const reset = await authenticated(adminJar, {
      method: 'POST',
      url: `/admin/users/${target.id}/reset-password`,
    });
    expect(reset.statusCode).toBe(200);
    const temporary = reset.json<{ temporaryPassword: string }>().temporaryPassword;
    expect((await login('coordinator.test', 'Coordinator-New-Pass-42!')).response.statusCode).toBe(
      401,
    );
    const fresh = await login('coordinator.test', temporary);
    expect(fresh.response.statusCode).toBe(200);

    const assigned = await authenticated(adminJar, {
      method: 'PUT',
      url: `/admin/users/${target.id}/roles`,
      payload: { roles: ['ADMIN', 'COORDINATOR'] },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json<{ user: { roles: string[] } }>().user.roles).toEqual([
      'ADMIN',
      'COORDINATOR',
    ]);
    expect(
      (
        await authenticated(adminJar, {
          method: 'PUT',
          url: `/admin/users/${target.id}/roles`,
          payload: { roles: ['COORDINATOR'] },
        })
      ).statusCode,
    ).toBe(200);

    const revoked = await authenticated(adminJar, {
      method: 'POST',
      url: `/admin/users/${target.id}/sessions/revoke-all`,
    });
    expect(revoked.statusCode).toBe(200);
    expect((await authenticated(fresh.jar!, { method: 'GET', url: '/auth/me' })).statusCode).toBe(
      401,
    );

    const updated = await authenticated(adminJar, {
      method: 'PATCH',
      url: `/admin/users/${target.id}`,
      payload: { displayName: 'Coordinador actualizado' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ user: { displayName: string } }>().user.displayName).toBe(
      'Coordinador actualizado',
    );
    const audit = await authenticated(adminJar, { method: 'GET', url: '/admin/audit' });
    expect(audit.statusCode).toBe(200);
    expect(
      audit.json<{ events: { action: string }[] }>().events.map((event) => event.action),
    ).toContain('USER_UPDATED');
  });

  it('un usuario autenticado sin rol no accede a administración', async () => {
    const password = 'No-Role-Passphrase-42!';
    const passwordHash = await new PasswordService(env).hash(password, {
      username: 'no.role',
      email: 'no.role@example.invalid',
    });
    await db
      .insertInto('app_user')
      .values({
        username: 'no.role',
        email: 'no.role@example.invalid',
        display_name: 'Sin rol',
        password_hash: passwordHash,
        must_change_password: false,
        is_active: true,
        failed_login_count: 0,
        failed_login_window_started_at: null,
        locked_until: null,
        last_login_at: null,
        password_changed_at: new Date(),
        created_by: adminId,
      })
      .execute();
    const roleless = await login('no.role', password);
    expect(roleless.response.statusCode).toBe(200);
    const denied = await authenticated(roleless.jar!, { method: 'GET', url: '/admin/users' });
    expect(denied.statusCode).toBe(403);
  });

  it('un fallo crítico de auditoría revierte la operación administrativa', async () => {
    const owner = await connect(database.ownerUri);
    const before = await db
      .selectFrom('app_user')
      .select('display_name')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    try {
      await owner.query('REVOKE INSERT ON audit_event FROM factuflow_app');
      const response = await authenticated(adminJar, {
        method: 'PATCH',
        url: `/admin/users/${adminId}`,
        payload: { displayName: 'Este cambio debe revertirse' },
      });
      expect(response.statusCode).toBe(500);
      const after = await db
        .selectFrom('app_user')
        .select('display_name')
        .where('id', '=', adminId)
        .executeTakeFirstOrThrow();
      expect(after.display_name).toBe(before.display_name);
    } finally {
      await owner.query('GRANT INSERT ON audit_event TO factuflow_app');
      await owner.end();
    }
  });

  it('expira, revoca y cierra sesiones con auditoría sin secretos', async () => {
    const expiring = await login('admin.phase2', 'Admin-New-Passphrase-42!');
    const owner = await connect(database.ownerUri);
    try {
      await owner.query(
        `UPDATE app_session SET created_at = now() - interval '2 hours', last_seen_at = now() - interval '2 hours', idle_expires_at = now() - interval '1 hour' WHERE token_hash = $1`,
        [hashToken(expiring.jar!.sessionToken)],
      );
    } finally {
      await owner.end();
    }
    expect(
      (await authenticated(expiring.jar!, { method: 'GET', url: '/auth/me' })).statusCode,
    ).toBe(401);

    const revokeTarget = await login('admin.phase2', 'Admin-New-Passphrase-42!');
    const sessions = await authenticated(adminJar, { method: 'GET', url: '/auth/sessions' });
    const other = sessions
      .json<{ sessions: { id: string; current: boolean }[] }>()
      .sessions.find((session) => !session.current);
    expect(other).toBeDefined();
    expect(
      (
        await authenticated(adminJar, {
          method: 'DELETE',
          url: `/auth/sessions/${other!.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await authenticated(revokeTarget.jar!, { method: 'GET', url: '/auth/me' })).statusCode,
    ).toBe(401);

    const logoutSession = await login('admin.phase2', 'Admin-New-Passphrase-42!');
    const logout = await authenticated(logoutSession.jar!, { method: 'POST', url: '/auth/logout' });
    expect(logout.statusCode).toBe(200);
    expect(
      (await authenticated(logoutSession.jar!, { method: 'GET', url: '/auth/me' })).statusCode,
    ).toBe(401);

    const events = await db.selectFrom('audit_event').selectAll().execute();
    const serialized = JSON.stringify(events);
    expect(events.map((event) => event.action)).toContain('AUTH_SESSION_EXPIRED');
    expect(events.map((event) => event.action)).toContain('AUTH_SESSION_REVOKED');
    expect(events.map((event) => event.action)).toContain('AUTH_LOGOUT');
    expect(serialized).not.toContain(adminTemporary);
    expect(serialized).not.toContain('Admin-New-Passphrase-42!');
    expect(serialized).not.toContain(logoutSession.jar!.sessionToken);
    expect(serialized).not.toContain(hashToken(logoutSession.jar!.sessionToken));
  });
});
