import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';
import { assertNumericParsersUntouched } from './numeric-guard.js';

export interface DbOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

/**
 * Crea la conexión a PostgreSQL.
 *
 * Antes de abrir el pool, verifica que nadie haya registrado un type parser que
 * convierta NUMERIC a `number`. Si la regla está rota, no se conecta: es
 * preferible un arranque fallido y ruidoso a una factura silenciosamente mal
 * calculada. Ver numeric-guard.ts (R-02/R-08).
 *
 * La `connectionString` que llega aquí es siempre la del rol `factuflow_app`.
 * El rol `factuflow_owner` pertenece a las migraciones y no entra a este proceso.
 */
export function createDb({ connectionString, maxConnections = 10 }: DbOptions): Kysely<Database> {
  assertNumericParsersUntouched();

  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    // Una consulta que tarda mas que esto esta colgada, no lenta.
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Verifica que la base responde y devuelve la latencia en ms.
 * Lo usa /health (criterio de termino 4).
 */
export async function pingDatabase(db: Kysely<Database>): Promise<number> {
  const startedAt = performance.now();
  await sql`SELECT 1`.execute(db);
  return Math.round(performance.now() - startedAt);
}

/**
 * Reserva el siguiente correlativo de folio del anio, de forma atomica.
 *
 * Vive en infraestructura y no en el dominio porque su correccion depende del
 * bloqueo de fila de PostgreSQL, no de una regla de negocio.
 *
 * Fase 5: el XLSX se genera y valida primero, sin escribir en PostgreSQL. La
 * reserva se ejecuta despues dentro de la transaccion final que persiste la
 * solicitud, sus snapshots, el BYTEA y la auditoria. Cualquier fallo posterior
 * revierte tambien el contador; abrir o duplicar nunca llama esta funcion.
 */
export async function reserveFolio(
  db: Kysely<Database> | Transaction<Database>,
  year: number,
): Promise<number> {
  const result = await sql<{ reserve_folio: number }>`
    SELECT reserve_folio(${year}) AS reserve_folio
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`reserve_folio(${year}) no devolvio ninguna fila.`);
  }

  return row.reserve_folio;
}
