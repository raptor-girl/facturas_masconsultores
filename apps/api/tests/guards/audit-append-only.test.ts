import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import {
  startTestDatabase,
  connect,
  isPgError,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from '../setup/postgres.js';

/**
 * GUARDIA 2 — La auditoría es append-only de verdad (criterios 7 y 8).
 *
 * `SECURITY_AND_TRACEABILITY.md` afirma que `audit_event` no admite UPDATE ni
 * DELETE desde la aplicación. Esa afirmación es falsa por defecto: si la app se
 * conecta con el rol dueño del esquema —que es lo que pasa con una sola
 * DATABASE_URL— puede hacer ambas cosas. Sin esta prueba, «append-only» es una
 * intención (T-13).
 */
describe('Guardia: auditoría append-only', () => {
  let database: TestDatabase;
  let app: pg.Client;
  let owner: pg.Client;
  let insertedId: string;

  beforeAll(async () => {
    database = await startTestDatabase();
    app = await connect(database.appUri);
    owner = await connect(database.ownerUri);

    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO audit_event (action, entity, result)
       VALUES ('login', 'app_user', 'success')
       RETURNING id`,
    );
    insertedId = rows[0]?.id ?? '';
  }, 180_000);

  afterAll(async () => {
    await app.end();
    await owner.end();
    await database.stop();
  });

  it('el rol de aplicación SÍ puede insertar eventos', () => {
    expect(insertedId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('el rol de aplicación SÍ puede leer la auditoría', async () => {
    const { rows } = await app.query('SELECT id FROM audit_event WHERE id = $1', [insertedId]);
    expect(rows).toHaveLength(1);
  });

  it('el rol de aplicación NO puede modificar un evento', async () => {
    await expect(
      app.query(`UPDATE audit_event SET action = 'manipulado' WHERE id = $1`, [insertedId]),
    ).rejects.toSatisfy(
      (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
    );
  });

  it('el rol de aplicación NO puede borrar un evento', async () => {
    await expect(
      app.query('DELETE FROM audit_event WHERE id = $1', [insertedId]),
    ).rejects.toSatisfy(
      (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
    );
  });

  it('el rol de aplicación NO puede truncar la tabla', async () => {
    await expect(app.query('TRUNCATE audit_event')).rejects.toSatisfy(
      (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
    );
  });

  it('el evento sigue intacto después de los intentos', async () => {
    const { rows } = await app.query<{ action: string }>(
      'SELECT action FROM audit_event WHERE id = $1',
      [insertedId],
    );
    expect(rows[0]?.action).toBe('login');
  });

  // ── Criterio de término 8 ────────────────────────────────────────────────
  it('el rol de aplicación no es dueño de ninguna tabla', async () => {
    const { rows } = await owner.query<{ tablename: string; tableowner: string }>(
      `SELECT tablename, tableowner
         FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`,
    );

    expect(rows.length).toBeGreaterThan(0);

    const ownedByApp = rows.filter((r) => r.tableowner === 'factuflow_app');
    expect(ownedByApp).toEqual([]);

    for (const row of rows) {
      expect(row.tableowner).toBe('factuflow_owner');
    }
  });

  it('el rol de aplicación no puede crear objetos en el esquema', async () => {
    await expect(app.query('CREATE TABLE intento_de_tabla (id INT)')).rejects.toSatisfy(
      (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
    );
  });

  it('los privilegios de audit_event son exactamente INSERT y SELECT', async () => {
    const { rows } = await owner.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.table_privileges
        WHERE grantee = 'factuflow_app' AND table_name = 'audit_event'
        ORDER BY privilege_type`,
    );

    const granted = rows.map((r) => r.privilege_type).sort();
    expect(granted).toEqual(['INSERT', 'SELECT']);
  });
});
