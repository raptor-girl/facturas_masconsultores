import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { createDb } from '../infrastructure/postgres/db.js';
import { PostgresIdentityService } from '../infrastructure/postgres/identity-service.js';

const bootstrapSchema = z.object({
  username: z.string().trim().min(3).max(64),
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
});

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb({ connectionString: env.DATABASE_URL_APP, maxConnections: 2 });
  const prompt = createInterface({ input: stdin, output: stdout });

  try {
    // No se solicita ni acepta contraseña: la genera el proceso con CSPRNG para
    // que no aparezca en argumentos, historial ni variables de entorno.
    const input = bootstrapSchema.parse({
      username: await prompt.question('Username del primer ADMIN: '),
      email: await prompt.question('Correo del primer ADMIN: '),
      displayName: await prompt.question('Nombre visible del primer ADMIN: '),
    });
    const identity = new PostgresIdentityService(db, env);
    const result = await identity.bootstrapAdmin(input);

    // eslint-disable-next-line no-console
    console.log('\nADMIN inicial creado. Contraseña temporal (se muestra una sola vez):');
    // eslint-disable-next-line no-console
    console.log(result.temporaryPassword);
    // eslint-disable-next-line no-console
    console.log('Debe cambiarla en el primer inicio de sesión.');
  } finally {
    prompt.close();
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  // El error no contiene passwords ni hashes; el comando nunca los recibe.
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : 'No fue posible crear el ADMIN inicial.');
  process.exitCode = 1;
});
