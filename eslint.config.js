// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

/**
 * Límites entre capas — hechos exigibles, no aspiracionales.
 *
 * Una convención de carpetas no impide nada por sí sola: bastan seis semanas
 * de apuro para que un `import` de `pg` aparezca en `domain/`. Estas reglas
 * hacen fallar el CI cuando eso ocurre.
 *
 * Dirección permitida:
 *   presentation → application → domain
 *   infrastructure → domain
 *   domain → (nada)
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // tsconfig.eslint.json incluye src, tests y los *.config.ts. El
        // tsconfig.json raiz solo referencia los proyectos de build, asi que
        // con `projectService` las reglas con tipos fallarian sobre los tests
        // por «archivo no incluido en ningun proyecto».
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['./apps/*/tsconfig.json', './packages/*/tsconfig.json'],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
    },
  },

  // ───────────────────────────────────────────────────────────
  // Límite 1: el dominio no conoce a nadie.
  // ───────────────────────────────────────────────────────────
  {
    files: ['apps/api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'pg',
                'pg-*',
                'kysely',
                'kysely/*',
                'fastify',
                '@fastify/*',
                'node-pg-migrate',
                '**/infrastructure/**',
                '**/presentation/**',
                '**/application/**',
              ],
              message:
                'El dominio no puede importar infraestructura, presentación, aplicación ni frameworks. Define un puerto (interfaz) y que la infraestructura lo implemente. Ver RECOMMENDED_ARCHITECTURE.md.',
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────
  // Límite 2: la aplicación orquesta, no sabe de SQL ni de HTTP.
  // ───────────────────────────────────────────────────────────
  {
    files: ['apps/api/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'pg',
                'pg-*',
                'kysely',
                'kysely/*',
                'fastify',
                '@fastify/*',
                '**/presentation/**',
              ],
              message:
                'La capa de aplicación depende de puertos, no de PostgreSQL ni de HTTP. Recibe la implementación por inyección.',
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────
  // Límite 3: la presentación traduce HTTP ↔ casos de uso. Sin SQL.
  // ───────────────────────────────────────────────────────────
  {
    files: ['apps/api/src/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'pg-*'],
              message:
                'La capa de presentación no habla SQL. Usa un caso de uso o un repositorio de infraestructura.',
            },
          ],
        },
      ],
    },
  },

  // Config y tests: reglas relajadas donde no aportan.
  {
    files: ['**/*.config.ts', '**/*.config.js', 'eslint.config.js'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  {
    files: ['apps/api/tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // El frontend corre en el navegador.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: { 'no-console': 'off' },
  },
);
