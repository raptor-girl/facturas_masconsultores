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
 * GUARDIA 3 — El contador de folios bajo concurrencia (criterio 9).
 *
 * Dos defectos que esta prueba mantiene cerrados:
 *
 *   T-07 — con COUNT(*), dos exportaciones simultáneas obtienen el mismo folio.
 *          Un folio duplicado en un documento tributario no es un bug menor.
 *
 *   T-01 — el contador arranca en 0 para 2026, pero los folios legados
 *          SF-2026-000xx ya existen. Sin siembra, la PRIMERA exportación real
 *          del sistema nuevo choca contra UNIQUE. Fallaría en su estreno.
 */

const CONCURRENT_RESERVATIONS = 50;

describe('Guardia: concurrencia del contador de folios', () => {
  let database: TestDatabase;
  let owner: pg.Client;

  beforeAll(async () => {
    database = await startTestDatabase();
    owner = await connect(database.ownerUri);
  }, 180_000);

  afterAll(async () => {
    await owner.end();
    await database.stop();
  });

  it('50 reservas simultáneas producen 50 correlativos distintos, sin huecos', async () => {
    const year = 2030;

    // Conexiones independientes: sin esto no habría concurrencia real, solo
    // consultas encoladas en un mismo socket.
    const clients = await Promise.all(
      Array.from({ length: CONCURRENT_RESERVATIONS }, () => connect(database.appUri)),
    );

    try {
      const results = await Promise.all(
        clients.map(async (client) => {
          const { rows } = await client.query<{ folio: number }>(
            'SELECT reserve_folio($1) AS folio',
            [year],
          );
          return rows[0]?.folio ?? -1;
        }),
      );

      const sorted = [...results].sort((a, b) => a - b);
      const expected = Array.from({ length: CONCURRENT_RESERVATIONS }, (_, i) => i + 1);

      expect(new Set(results).size).toBe(CONCURRENT_RESERVATIONS); // sin duplicados
      expect(sorted).toEqual(expected); // sin huecos, empieza en 1
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('la primera reserva de un año nuevo devuelve 1', async () => {
    const app = await connect(database.appUri);
    try {
      const { rows } = await app.query<{ folio: number }>('SELECT reserve_folio(2031) AS folio');
      expect(rows[0]?.folio).toBe(1);
    } finally {
      await app.end();
    }
  });

  it('cada año lleva su propio correlativo', async () => {
    const app = await connect(database.appUri);
    try {
      await app.query('SELECT reserve_folio(2032)');
      await app.query('SELECT reserve_folio(2032)');
      const { rows } = await app.query<{ folio: number }>('SELECT reserve_folio(2033) AS folio');
      expect(rows[0]?.folio).toBe(1); // 2033 no hereda nada de 2032
    } finally {
      await app.end();
    }
  });

  // ── T-01: la colisión que habría roto el primer uso real ─────────────────
  it('sembrado desde el folio legado máximo, la siguiente reserva NO colisiona', async () => {
    const year = 2026;

    // Simula lo que hará la migración de datos: el mayor folio legado de 2026
    // es SF-2026-00080. Ver DATA_MIGRATION_PLAN.md §Folios.
    await owner.query('SELECT seed_folio_counter($1, $2)', [year, 80]);

    const app = await connect(database.appUri);
    try {
      const { rows } = await app.query<{ folio: number }>('SELECT reserve_folio($1) AS folio', [
        year,
      ]);
      // Sin la siembra esto habría devuelto 1 → SF-2026-00001 → ya existe → UNIQUE violado.
      expect(rows[0]?.folio).toBe(81);
    } finally {
      await app.end();
    }
  });

  it('la siembra es idempotente y nunca retrocede', async () => {
    const year = 2027;

    await owner.query('SELECT seed_folio_counter($1, $2)', [year, 50]);
    await owner.query('SELECT seed_folio_counter($1, $2)', [year, 50]); // reintento del lote
    await owner.query('SELECT seed_folio_counter($1, $2)', [year, 10]); // valor menor: se ignora

    const { rows } = await owner.query<{ last_value: number }>(
      'SELECT last_value FROM folio_counter WHERE year = $1',
      [year],
    );
    expect(rows[0]?.last_value).toBe(50);
  });

  // ── El contador solo se mueve por la vía autorizada ──────────────────────
  it('el rol de aplicación NO puede modificar el contador directamente', async () => {
    const app = await connect(database.appUri);
    try {
      await expect(app.query('UPDATE folio_counter SET last_value = 0')).rejects.toSatisfy(
        (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
      );
    } finally {
      await app.end();
    }
  });

  it('el rol de aplicación NO puede sembrar el contador', async () => {
    const app = await connect(database.appUri);
    try {
      await expect(app.query('SELECT seed_folio_counter(2026, 99999)')).rejects.toSatisfy(
        (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
      );
    } finally {
      await app.end();
    }
  });
});
