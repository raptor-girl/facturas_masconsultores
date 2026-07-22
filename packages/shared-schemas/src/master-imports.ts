import { z } from 'zod';
import {
  dataStatusSchema,
  documentRequirementSchema,
  excelTemplateVariantSchema,
  projectCenterTypeSchema,
  taxTreatmentSchema,
} from './masters.js';

const id = z.string().uuid();
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const externalId = nonEmpty(120);
const nullableLongText = z.string().trim().max(2000).nullable().default(null);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const decimalRate = z.string().regex(/^\d+(?:\.\d{1,4})?$/, 'La tasa debe ser decimal');

const importArray = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).max(2_000).default([]);

export const legacyImportModeSchema = z.enum(['PREVIEW', 'APPLY']);
export const legacyImportStatusSchema = z.enum(['PREVIEWED', 'APPLIED', 'REJECTED']);
export const legacyImportEntitySchema = z.enum([
  'issuer_company',
  'coordinator_profile',
  'client',
  'client_invoice_rule',
  'receiver',
  'product',
  'project_center',
]);
export const legacyImportOperationSchema = z.enum(['CREATE', 'UPDATE', 'NOOP', 'ERROR']);
export type LegacyImportMode = z.infer<typeof legacyImportModeSchema>;
export type LegacyImportStatus = z.infer<typeof legacyImportStatusSchema>;
export type LegacyImportEntity = z.infer<typeof legacyImportEntitySchema>;
export type LegacyImportOperation = z.infer<typeof legacyImportOperationSchema>;

export const legacyMasterImportOptionsSchema = z.object({
  allowUpdates: z.boolean().default(false),
});
export type LegacyMasterImportOptions = z.infer<typeof legacyMasterImportOptionsSchema>;

export const legacyIssuerCompanyImportSchema = z.object({
  externalId,
  code: nonEmpty(32),
  legalName: nonEmpty(200),
  taxId: nonEmpty(20),
  businessActivity: nonEmpty(300),
  address: nonEmpty(500),
  defaultTaxTreatment: taxTreatmentSchema,
  defaultIvaRate: decimalRate,
  isActive: z.boolean().default(true),
});
export type LegacyIssuerCompanyImport = z.infer<typeof legacyIssuerCompanyImportSchema>;

export const legacyCoordinatorImportSchema = z.object({
  externalId,
  displayName: nonEmpty(120),
  email: z.string().trim().email().max(254).nullable().default(null),
  isActive: z.boolean().default(true),
});
export type LegacyCoordinatorImport = z.infer<typeof legacyCoordinatorImportSchema>;

export const legacyClientImportSchema = z
  .object({
    externalId,
    shortName: nonEmpty(120),
    legalName: z.string().trim().max(500).nullable().default(null),
    taxId: z.string().trim().max(20).nullable().default(null),
    businessActivity: z.string().trim().max(500).nullable().default(null),
    address: z.string().trim().max(500).nullable().default(null),
    defaultCoordinatorExternalId: externalId.nullable().default(null),
    dataStatus: dataStatusSchema,
    isActive: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (
      value.dataStatus === 'COMPLETE' &&
      (!value.taxId || !value.legalName || !value.businessActivity || !value.address)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Un cliente COMPLETE requiere RUT, razón social, giro y dirección.',
      });
    }
  });
export type LegacyClientImport = z.infer<typeof legacyClientImportSchema>;

export const legacyClientInvoiceRuleImportSchema = z.object({
  clientExternalId: externalId,
  purchaseOrderRequirement: documentRequirementSchema,
  hesRequirement: documentRequirementSchema,
  contractRequirement: documentRequirementSchema,
  supplierNumber: z.string().trim().max(120).nullable().default(null),
  defaultIssuerCompanyExternalId: externalId.nullable().default(null),
  defaultTaxTreatment: taxTreatmentSchema.nullable().default(null),
  excelTemplateVariant: excelTemplateVariantSchema,
  billingNotes: nullableLongText,
  isActive: z.boolean().default(true),
});
export type LegacyClientInvoiceRuleImport = z.infer<typeof legacyClientInvoiceRuleImportSchema>;

export const legacyReceiverImportSchema = z.object({
  externalId,
  clientExternalId: externalId,
  displayName: z.string().trim().max(120).nullable().default(null),
  email: z.string().trim().email().max(254),
  isActive: z.boolean().default(true),
});
export type LegacyReceiverImport = z.infer<typeof legacyReceiverImportSchema>;

export const legacyProductImportSchema = z.object({
  externalId,
  code: z.string().trim().min(1).max(32).nullable().default(null),
  name: nonEmpty(160),
  isActive: z.boolean().default(true),
});
export type LegacyProductImport = z.infer<typeof legacyProductImportSchema>;

export const legacyProjectCenterImportSchema = z.object({
  externalId,
  clientExternalId: externalId,
  productExternalId: externalId,
  code: nonEmpty(64),
  projectName: nonEmpty(200),
  projectCenterType: projectCenterTypeSchema,
  isActive: z.boolean().default(true),
});
export type LegacyProjectCenterImport = z.infer<typeof legacyProjectCenterImportSchema>;

export const legacyMasterImportPayloadSchema = z.object({
  sourceName: nonEmpty(120),
  sourceSha256: sha256.optional(),
  options: legacyMasterImportOptionsSchema.default({}),
  issuerCompanies: importArray(legacyIssuerCompanyImportSchema),
  coordinators: importArray(legacyCoordinatorImportSchema),
  clients: importArray(legacyClientImportSchema),
  invoiceRules: importArray(legacyClientInvoiceRuleImportSchema),
  receivers: importArray(legacyReceiverImportSchema),
  products: importArray(legacyProductImportSchema),
  projectCenters: importArray(legacyProjectCenterImportSchema),
});
export type LegacyMasterImportPayload = z.infer<typeof legacyMasterImportPayloadSchema>;

export const legacyMasterImportParamsSchema = z.object({ id });

export const legacyMasterImportIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type LegacyMasterImportIssue = z.infer<typeof legacyMasterImportIssueSchema>;

export const legacyMasterImportItemSchema = z.object({
  entity: legacyImportEntitySchema,
  rowNumber: z.number().int().positive(),
  externalId: z.string().nullable(),
  operation: legacyImportOperationSchema,
  targetId: id.nullable(),
  issues: z.array(legacyMasterImportIssueSchema),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});
export type LegacyMasterImportItem = z.infer<typeof legacyMasterImportItemSchema>;

const entityCounts = z.object({
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  noop: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
});

export const legacyMasterImportSummarySchema = entityCounts.extend({
  total: z.number().int().nonnegative(),
  byEntity: z.record(legacyImportEntitySchema, entityCounts),
});
export type LegacyMasterImportSummary = z.infer<typeof legacyMasterImportSummarySchema>;

export const legacyMasterImportRunSchema = z.object({
  id,
  mode: legacyImportModeSchema,
  status: legacyImportStatusSchema,
  sourceName: z.string(),
  sourceSha256: sha256,
  payloadHash: sha256,
  summary: legacyMasterImportSummarySchema,
  createdAt: z.string().datetime(),
  items: z.array(legacyMasterImportItemSchema),
});
export type LegacyMasterImportRun = z.infer<typeof legacyMasterImportRunSchema>;

export const legacyMasterImportRunResponseSchema = z.object({
  importRun: legacyMasterImportRunSchema,
});
