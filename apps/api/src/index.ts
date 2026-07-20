import { loadEnv } from './config/env.js';
import { createDb } from './infrastructure/postgres/db.js';
import { buildServer } from './presentation/http/server.js';

const VERSION = '0.1.0';

/**
 * Arranque del API.
 *
 * Orden deliberado: primero se valida el entorno, despues se conecta la base.
 * Si falta una variable obligatoria, el proceso muere aqui con un mensaje claro
 * y sin haber abierto ninguna conexion (criterio de termino 10).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb({ connectionString: env.DATABASE_URL_APP });
  const app = await buildServer({ env, db, version: VERSION });

  // Cierre ordenado: deja de aceptar peticiones, termina las que estan en
  // vuelo y recien ahi suelta el pool. Sin esto, un despliegue corta consultas
  // a la mitad y deja conexiones colgando en PostgreSQL.
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return; // un segundo SIGTERM no debe reentrar
    closing = true;
    app.log.info({ signal }, 'Apagando: cerrando servidor HTTP');
    try {
      await app.close();
      app.log.info('Servidor HTTP cerrado; cerrando pool de PostgreSQL');
      await db.destroy();
      app.log.info('Apagado limpio');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Fallo durante el apagado');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
