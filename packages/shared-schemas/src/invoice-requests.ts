import { z } from 'zod';
import { excelTemplateVariantSchema, taxTreatmentSchema } from './masters.js';
import { ufSourceSchema } from './uf.js';

const id = z.string().uuid();
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe usar YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'La fecha no existe');
const dateTime = z.string().datetime();
const decimalString = (integerDigits: number, scale: number) =>
  z
    .string()
    .regex(
      new RegExp(`^(?:0|[1-9]\\d{0,${integerDigits - 1}})(?:\\.\\d{1,${scale}})?$`),
      `Debe ser un decimal canónico con hasta ${integerDigits} enteros y ${scale} decimales`,
    );
const canonicalDecimal = decimalString(30, 6);
const positiveDecimal = decimalString(24, 6).refine(
  (value) => /[1-9]/.test(value),
  'El valor debe ser mayor que cero',
);
const positiveUfValue = decimalString(14, 6).refine(
  (value) => /[1-9]/.test(value),
  'El valor debe ser mayor que cero',
);
const nullableTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === '' ? null : value));

export const INVOICE_REQUEST_MAX_LINES = 100;
export const INVOICE_REQUEST_MAX_RECEIVERS = 20;
export const INVOICE_EXPORT_MAX_BYTES = 5 * 1024 * 1024;
export const INVOICE_AREA = 'Plataformas' as const;
export const INVOICE_CALCULATION_VERSION = 'LEGACY_V1' as const;
export const INVOICE_CANDIDATE_TEMPLATE_VERSION = 'SOLICITUD_FACTURA_CLONE_CANDIDATE_V1' as const;
// Identifica archivos ya persistidos por Fase 5. No se usa para generar ni
// regenerar documentos nuevos: la descarga historica devuelve su BYTEA exacto.
export const INVOICE_LEGACY_TECHNICAL_TEMPLATE_VERSION = 'TECHNICAL_V1_UNAPPROVED' as const;
export const INVOICE_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

export const invoiceRequestStatusSchema = z.literal('EXPORTED');
export const invoiceRequestIdParamsSchema = z.object({ id });
export const idempotencyHeadersSchema = z.object({
  'idempotency-key': z
    .string()
    .min(16)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contiene caracteres no permitidos'),
});

export const invoiceRequestLineInputSchema = z.object({
  projectCenterId: id,
  ufAmount: positiveDecimal,
  position: z.number().int().min(1).max(INVOICE_REQUEST_MAX_LINES),
});

export const invoiceRequestReceiverInputSchema = z.object({
  receiverId: id.nullable().default(null),
  displayName: nullableTrimmed(200).default(null),
  email: z.string().trim().toLowerCase().email().max(320),
  position: z.number().int().min(1).max(INVOICE_REQUEST_MAX_RECEIVERS),
});

export const invoiceRequestExportSchema = z
  .object({
    sourceRequestId: id.nullable().default(null),
    clientId: id,
    issuerCompanyId: id,
    coordinatorProfileId: id,
    period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, 'El período debe usar YYYY-MM'),
    requestDate: dateOnly,
    billingDate: dateOnly,
    ufDate: dateOnly,
    ufValue: positiveUfValue,
    taxTreatment: taxTreatmentSchema,
    taxRate: canonicalDecimal.optional(),
    area: z.literal(INVOICE_AREA),
    purchaseOrderNumber: nullableTrimmed(200).default(null),
    contractNumber: nullableTrimmed(200).default(null),
    hesNumber: nullableTrimmed(200).default(null),
    supplierNumber: nullableTrimmed(200).default(null),
    description: z.string().trim().min(1).max(1000),
    observations: nullableTrimmed(4000).default(null),
    lines: z.array(invoiceRequestLineInputSchema).min(1).max(INVOICE_REQUEST_MAX_LINES),
    receivers: z.array(invoiceRequestReceiverInputSchema).min(1).max(INVOICE_REQUEST_MAX_RECEIVERS),
  })
  .strict()
  .superRefine((value, context) => {
    const linePositions = new Set(value.lines.map((line) => line.position));
    const centerIds = new Set(value.lines.map((line) => line.projectCenterId));
    if (linePositions.size !== value.lines.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Las posiciones de líneas deben ser únicas',
      });
    }
    if (centerIds.size !== value.lines.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Cada CP/MS puede aparecer una sola vez',
      });
    }

    const receiverPositions = new Set(value.receivers.map((receiver) => receiver.position));
    const receiverEmails = new Set(value.receivers.map((receiver) => receiver.email));
    if (receiverPositions.size !== value.receivers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receivers'],
        message: 'Las posiciones de receptores deben ser únicas',
      });
    }
    if (receiverEmails.size !== value.receivers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receivers'],
        message: 'No puede repetir un correo receptor',
      });
    }
  });

export type InvoiceRequestExportInput = z.infer<typeof invoiceRequestExportSchema>;

export const invoiceRequestListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  clientId: id.optional(),
  coordinatorProfileId: id.optional(),
  period: z
    .string()
    .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
    .optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  billingFrom: dateOnly.optional(),
  billingTo: dateOnly.optional(),
  taxTreatment: taxTreatmentSchema.optional(),
  status: invoiceRequestStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type InvoiceRequestListQuery = z.infer<typeof invoiceRequestListQuerySchema>;

export const invoiceRequestListItemSchema = z.object({
  id,
  folio: z.string(),
  status: invoiceRequestStatusSchema,
  statusLabel: z.literal('Factura solicitada'),
  clientId: id,
  clientShortName: z.string(),
  issuerCompanyId: id,
  issuerCompanyLegalName: z.string(),
  coordinatorProfileId: id,
  coordinatorDisplayName: z.string(),
  period: z.string(),
  requestDate: dateOnly,
  billingDate: dateOnly,
  taxTreatment: taxTreatmentSchema,
  netClp: canonicalDecimal,
  ivaClp: canonicalDecimal,
  totalClp: canonicalDecimal,
  exportedAt: dateTime,
  createdBy: id,
  sourceRequestId: id.nullable(),
});
export type InvoiceRequestListItem = z.infer<typeof invoiceRequestListItemSchema>;

export const invoiceRequestLineSchema = z.object({
  id,
  position: z.number().int(),
  projectCenterId: id,
  projectCenterCode: z.string(),
  projectName: z.string(),
  projectCenterType: z.string(),
  productId: id.nullable(),
  productCode: z.string().nullable(),
  productName: z.string().nullable(),
  ufAmount: positiveDecimal,
  ufValue: positiveUfValue,
  clpAmount: canonicalDecimal,
});

export const invoiceRequestReceiverSchema = z.object({
  id,
  position: z.number().int(),
  receiverId: id.nullable(),
  displayName: z.string().nullable(),
  email: z.string().email(),
});

const versionedSnapshot = z.object({ schemaVersion: z.literal(1) }).passthrough();

export const invoiceExportMetadataSchema = z.object({
  id,
  filename: z.string(),
  mimeType: z.literal(INVOICE_XLSX_MIME),
  sizeBytes: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  templateVariant: excelTemplateVariantSchema,
  templateVersion: z.string(),
  createdAt: dateTime,
});

export const invoiceRequestDetailSchema = invoiceRequestListItemSchema.extend({
  ufDate: dateOnly,
  ufValue: positiveUfValue,
  ufSource: ufSourceSchema,
  ivaRate: canonicalDecimal,
  area: z.literal(INVOICE_AREA),
  purchaseOrderNumber: z.string().nullable(),
  contractNumber: z.string().nullable(),
  hesNumber: z.string().nullable(),
  supplierNumber: z.string().nullable(),
  description: z.string(),
  observations: z.string().nullable(),
  calculationAlgorithmVersion: z.literal(INVOICE_CALCULATION_VERSION),
  excelTemplateVariant: excelTemplateVariantSchema,
  excelTemplateVersion: z.string(),
  clientSnapshot: versionedSnapshot,
  issuerCompanySnapshot: versionedSnapshot,
  coordinatorSnapshot: versionedSnapshot,
  invoiceRuleSnapshot: versionedSnapshot,
  createdAt: dateTime,
  lines: z.array(invoiceRequestLineSchema),
  receivers: z.array(invoiceRequestReceiverSchema),
  export: invoiceExportMetadataSchema,
});
export type InvoiceRequestDetail = z.infer<typeof invoiceRequestDetailSchema>;

export const invoiceRequestsPageSchema = z.object({
  items: z.array(invoiceRequestListItemSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const invoiceRequestResponseSchema = z.object({
  invoiceRequest: invoiceRequestDetailSchema,
});

export const duplicateSourceSchema = invoiceRequestExportSchema;
export const duplicateSourceResponseSchema = z.object({ source: duplicateSourceSchema });
export type InvoiceRequestDuplicateSource = z.infer<typeof duplicateSourceSchema>;
