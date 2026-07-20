import { z } from 'zod';

const corsOriginSchema = z
  .string()
  .url()
  .regex(/^https?:\/\//, 'CORS_ORIGINS sólo admite orígenes http:// o https://');

/**
 * Validación de variables de entorno al arranque (criterio de término 10).
 *
 * Falla temprano y con un mensaje que dice exactamente qué falta. La
 * alternativa —descubrir que DATABASE_URL_APP era `undefined` cuando la primera
 * consulta explota— es peor y más cara.
 *
 * ⚠️ Nota deliberada: aquí NO se valida DATABASE_URL_OWNER. El API no debe
 * conocerla. El rol propietario es exclusivo de las migraciones; si el proceso
 * de aplicación tuviera esa URL, el append-only de la auditoría dejaría de ser
 * un control y pasaría a ser una promesa (T-13).
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().max(65535).default(3000),

    DATABASE_URL_APP: z
      .string()
      .min(1, 'DATABASE_URL_APP es obligatoria')
      .startsWith('postgresql://', 'DATABASE_URL_APP debe ser una URL postgresql://'),

    /**
     * Orígenes permitidos para CORS, separados por coma. Lista explícita, nunca
     * comodín: `*` con credenciales es un agujero, y este API acabará usando
     * cookies de sesión (Fase 2).
     */
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(corsOriginSchema).min(1, 'CORS_ORIGINS debe traer al menos un origen válido')),

    /** Techo de peticiones por ventana. Previsto, sin sobreimplementar. */
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW: z.string().min(1).default('1 minute'),

    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('factuflow_session'),
    SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(480),
    SESSION_ABSOLUTE_MINUTES: z.coerce.number().int().positive().default(1440),
    SESSION_ACTIVITY_UPDATE_MINUTES: z.coerce.number().int().positive().default(5),

    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(2).max(20).default(5),
    LOGIN_ATTEMPT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
    LOGIN_ATTEMPT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

    PASSWORD_HASH_MEMORY_KIB: z.coerce.number().int().positive().default(65_536),
    PASSWORD_HASH_TIME_COST: z.coerce.number().int().min(2).default(3),
    PASSWORD_HASH_PARALLELISM: z.coerce.number().int().positive().max(8).default(1),
  })
  .superRefine((value, context) => {
    if (value.SESSION_IDLE_MINUTES > value.SESSION_ABSOLUTE_MINUTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_IDLE_MINUTES'],
        message: 'no puede superar SESSION_ABSOLUTE_MINUTES',
      });
    }

    const minimumMemory = value.NODE_ENV === 'test' ? 8_192 : 65_536;
    if (value.PASSWORD_HASH_MEMORY_KIB < minimumMemory) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PASSWORD_HASH_MEMORY_KIB'],
        message: `debe ser al menos ${String(minimumMemory)} KiB en ${value.NODE_ENV}`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Configuración de entorno inválida. La aplicación no arranca.\n\n${detail}\n\n` +
        `Copia .env.example a .env y completa los valores faltantes.`,
    );
  }

  // Defensa explícita: si alguien inyecta la URL del owner en el proceso del
  // API, es un error de configuración, no una comodidad.
  if (source['DATABASE_URL_OWNER'] !== undefined && parsed.data.NODE_ENV === 'production') {
    throw new Error(
      'DATABASE_URL_OWNER está presente en el entorno del API en producción. ' +
        'El rol propietario es exclusivo de las migraciones: con él, la aplicación ' +
        'podría alterar audit_event y la auditoría dejaría de ser append-only (T-13).',
    );
  }

  return parsed.data;
}
