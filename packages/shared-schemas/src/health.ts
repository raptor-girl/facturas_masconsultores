import { z } from 'zod';

/**
 * Contrato del endpoint /health.
 *
 * Vive aquí, y no dentro del API, porque es el mismo objeto que el frontend
 * consume: un solo esquema, dos consumidores. Si el contrato cambia, el
 * compilador rompe ambos lados en vez de dejar que se descubra en runtime.
 */
export const healthStatusSchema = z.enum(['ok', 'degraded']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const healthCheckSchema = z.object({
  name: z.literal('postgres'),
  status: healthStatusSchema,
  latencyMs: z.number().int().nonnegative().nullable(),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.array(healthCheckSchema),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
