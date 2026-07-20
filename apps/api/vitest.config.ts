import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Testcontainers levanta PostgreSQL real: la primera descarga de imagen
    // puede tardar. Sin timeout amplio, el primer `npm test` en una maquina
    // limpia falla por razones que no tienen que ver con el codigo.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Un contenedor por archivo, en serie: mas lento pero determinista.
    // La prueba de concurrencia de folios necesita una base para ella sola.
    fileParallelism: false,
    pool: 'forks',
    reporters: ['verbose'],
  },
});
