import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

/**
 * PostgreSQL 16 real para las pruebas — nunca un doble.
 *
 * Un mock de base de datos no puede probar nada de lo que esta fase promete:
 * que `factuflow_app` no puede hacer UPDATE sobre `audit_event`, que NUMERIC
 * llega como string, o que reserve_folio se serializa bajo concurrencia. Esas
 * propiedades son de PostgreSQL, no del código. Probarlas contra un doble sería
 * probar el doble (R-12).
 *
 * Reproduce exactamente la topología de producción:
 *   superusuario  → solo crea los roles y la base (como el initdb de Docker)
 *   factuflow_owner → dueño del esquema, corre las migraciones
 *   factuflow_app   → el que usa la aplicación, con permisos limitados
 */

const OWNER_ROLE = 'factuflow_owner';
const APP_ROLE = 'factuflow_app';
const OWNER_PASSWORD = 'ownerpwtest';
const APP_PASSWORD = 'apppwtest';
const DB_NAME = 'factuflow';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationCli = resolve(
  apiRoot,
  '..',
  '..',
  'node_modules',
  'node-pg-migrate',
  'bin',
  'node-pg-migrate.js',
);

export interface TestDatabase {
  /** URL del rol propietario. Solo migraciones y montaje de fixtures. */
  readonly ownerUri: string;
  /** URL del rol de aplicación. Es la que usa el API. */
  readonly appUri: string;
  readonly stop: () => Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();

  const host = container.getHost();
  const port = container.getPort();

  // ── Bootstrap: mismo contenido que infra/docker/postgres-initdb ──────────
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PASSWORD}'`);
    await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
    await admin.query(`CREATE DATABASE ${DB_NAME} OWNER ${OWNER_ROLE}`);
    await admin.query(`REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${APP_ROLE}`);
  } finally {
    await admin.end();
  }

  const ownerUri = `postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${host}:${port}/${DB_NAME}`;
  const appUri = `postgresql://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${DB_NAME}`;

  // ── Migraciones: con el rol propietario, nunca con el de aplicación ──────
  // Se ejecutan las migraciones REALES del repositorio. Si el test montara el
  // esquema por su cuenta, probaría un esquema que no existe en producción.
  execFileSync(process.execPath, [migrationCli, '--database-url-var', 'DATABASE_URL_OWNER', 'up'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL_OWNER: ownerUri },
    stdio: 'pipe',
  });

  return {
    ownerUri,
    appUri,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Cliente suelto para pruebas que necesitan una conexión propia. */
export async function connect(uri: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  return client;
}

/** Código de error de PostgreSQL para «privilegio insuficiente». */
export const INSUFFICIENT_PRIVILEGE = '42501';

export function isPgError(error: unknown): error is pg.DatabaseError {
  return error instanceof Error && 'code' in error;
}
