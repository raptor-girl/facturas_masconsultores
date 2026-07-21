import { z } from 'zod';

const uuid = z.string().uuid();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe usar YYYY-MM-DD');
const unsignedDecimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'Debe ser un decimal canónico como string');
const positiveDecimal = unsignedDecimal.refine(
  (value) => /[1-9]/.test(value),
  'El valor debe ser mayor que cero',
);

export const ufDateParamsSchema = z.object({ date: dateOnly });
export const ufSourceSchema = z.enum(['sii.cl', 'mindicador.cl']);
export const ufValueSchema = z.object({
  id: uuid,
  date: dateOnly,
  value: positiveDecimal,
  source: ufSourceSchema,
  fetchedAt: z.string().datetime(),
  sourceReference: z.string().url().nullable(),
  fromCache: z.boolean(),
});

export const calculationLineInputSchema = z.object({
  projectCenterId: uuid,
  ufAmount: positiveDecimal,
  position: z.number().int().positive(),
});

export const invoicePreviewRequestSchema = z
  .object({
    ufDate: dateOnly,
    ufValue: positiveDecimal.optional(),
    taxTreatment: z.enum(['AFFECTED', 'EXEMPT']),
    taxRate: unsignedDecimal.optional(),
    lines: z.array(calculationLineInputSchema).min(1).max(100),
  })
  .superRefine((value, context) => {
    const positions = new Set(value.lines.map((line) => line.position));
    if (positions.size !== value.lines.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Las posiciones deben ser únicas',
      });
    }

    const centers = new Set(value.lines.map((line) => line.projectCenterId));
    if (centers.size !== value.lines.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Cada CP/MS puede aparecer una sola vez',
      });
    }
  });

export const calculatedLineSchema = z.object({
  projectCenterId: uuid,
  projectCenterCode: z.string(),
  projectName: z.string(),
  ufAmount: positiveDecimal,
  ufValue: positiveDecimal,
  clpAmount: unsignedDecimal,
  position: z.number().int().positive(),
});

export const invoicePreviewResponseSchema = z.object({
  algorithmVersion: z.literal('LEGACY_V1'),
  taxTreatment: z.enum(['AFFECTED', 'EXEMPT']),
  taxRate: unsignedDecimal,
  ufDate: dateOnly,
  ufValue: positiveDecimal,
  ufSource: ufSourceSchema.nullable(),
  ufFromCache: z.boolean().nullable(),
  sumUf: unsignedDecimal,
  netClp: unsignedDecimal,
  ivaClp: unsignedDecimal,
  totalClp: unsignedDecimal,
  clientId: uuid,
  lines: z.array(calculatedLineSchema),
});

export type UfValue = z.infer<typeof ufValueSchema>;
export type InvoicePreviewRequest = z.infer<typeof invoicePreviewRequestSchema>;
export type InvoicePreviewResponse = z.infer<typeof invoicePreviewResponseSchema>;
