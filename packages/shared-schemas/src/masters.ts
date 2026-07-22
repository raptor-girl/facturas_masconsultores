import { z } from 'zod';

const id = z.string().uuid();
const nullableText = z.string().trim().max(500).nullable();
const dateTime = z.string().datetime();
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

export const taxTreatmentSchema = z.enum(['AFFECTED', 'EXEMPT']);
export const dataStatusSchema = z.enum(['COMPLETE', 'PENDING_COMPLETION']);
export const documentRequirementSchema = z.enum(['REQUIRED', 'OPTIONAL', 'NOT_APPLICABLE']);
export const excelTemplateVariantSchema = z.enum(['STANDARD', 'HABITAT']);
export const projectCenterTypeSchema = z.enum([
  'ADMINISTRATION_OPERATION',
  'DEVELOPMENT_HOURS',
  'CONSTRUCTION',
]);

export type TaxTreatment = z.infer<typeof taxTreatmentSchema>;
export type DataStatus = z.infer<typeof dataStatusSchema>;
export type DocumentRequirement = z.infer<typeof documentRequirementSchema>;
export type ExcelTemplateVariant = z.infer<typeof excelTemplateVariantSchema>;
export type ProjectCenterType = z.infer<typeof projectCenterTypeSchema>;

export const uuidParamsSchema = z.object({ id });
export const clientIdParamsSchema = z.object({ clientId: id });
export const receiverIdParamsSchema = z.object({ id });
export const coordinatorUserLinkSchema = z.object({ appUserId: id });

export const masterListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['name', 'createdAt']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type MasterListQuery = z.infer<typeof masterListQuerySchema>;

const timestamps = { createdAt: dateTime, updatedAt: dateTime };
const decimalRate = z.string().regex(/^\d+(?:\.\d{1,4})?$/, 'La tasa debe ser decimal');

export const issuerCompanySchema = z.object({
  id,
  code: z.string(),
  legalName: z.string(),
  taxId: z.string(),
  businessActivity: z.string(),
  address: z.string(),
  isActive: z.boolean(),
  defaultTaxTreatment: taxTreatmentSchema,
  defaultIvaRate: decimalRate,
  ...timestamps,
});
export type IssuerCompany = z.infer<typeof issuerCompanySchema>;

export const createIssuerCompanySchema = z.object({
  code: nonEmpty(32),
  legalName: nonEmpty(200),
  taxId: nonEmpty(20),
  businessActivity: nonEmpty(300),
  address: nonEmpty(500),
  defaultTaxTreatment: taxTreatmentSchema,
  defaultIvaRate: decimalRate,
});
export type CreateIssuerCompany = z.infer<typeof createIssuerCompanySchema>;
export const updateIssuerCompanySchema = createIssuerCompanySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Debe indicar al menos un cambio');
export type UpdateIssuerCompany = z.infer<typeof updateIssuerCompanySchema>;

export const coordinatorProfileSchema = z.object({
  id,
  appUserId: id.nullable(),
  displayName: z.string(),
  email: z.string().email().nullable(),
  isActive: z.boolean(),
  ...timestamps,
});
export type CoordinatorProfile = z.infer<typeof coordinatorProfileSchema>;
export const createCoordinatorSchema = z.object({
  displayName: nonEmpty(120),
  email: z.string().trim().email().max(254).nullable().default(null),
  appUserId: id.nullable().default(null),
});
export type CreateCoordinator = z.infer<typeof createCoordinatorSchema>;
export const updateCoordinatorSchema = createCoordinatorSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Debe indicar al menos un cambio');
export type UpdateCoordinator = z.infer<typeof updateCoordinatorSchema>;

export const clientSchema = z.object({
  id,
  shortName: z.string(),
  legalName: z.string().nullable(),
  taxId: z.string().nullable(),
  businessActivity: z.string().nullable(),
  address: z.string().nullable(),
  defaultCoordinatorProfileId: id.nullable(),
  defaultCoordinatorDisplayName: z.string().nullable(),
  dataStatus: dataStatusSchema,
  isActive: z.boolean(),
  ...timestamps,
});
export type Client = z.infer<typeof clientSchema>;
const clientInputObject = z.object({
  shortName: nonEmpty(120),
  legalName: nullableText.default(null),
  taxId: z.string().trim().max(20).nullable().default(null),
  businessActivity: nullableText.default(null),
  address: nullableText.default(null),
  defaultCoordinatorProfileId: id.nullable().default(null),
  dataStatus: dataStatusSchema,
});

export const createClientSchema = clientInputObject.superRefine((value, context) => {
  if (
    value.dataStatus === 'COMPLETE' &&
    (!value.taxId || !value.legalName || !value.businessActivity || !value.address)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Un cliente COMPLETE requiere todos sus datos legales.',
    });
  }
});
export type CreateClient = z.infer<typeof createClientSchema>;
export const updateClientSchema = clientInputObject
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Debe indicar al menos un cambio');
export type UpdateClient = z.infer<typeof updateClientSchema>;

export const invoiceRuleSchema = z.object({
  clientId: id,
  purchaseOrderRequirement: documentRequirementSchema,
  hesRequirement: documentRequirementSchema,
  contractRequirement: documentRequirementSchema,
  supplierNumber: z.string().nullable(),
  defaultIssuerCompanyId: id.nullable(),
  defaultTaxTreatment: taxTreatmentSchema.nullable(),
  excelTemplateVariant: excelTemplateVariantSchema,
  billingNotes: z.string().nullable(),
  isActive: z.boolean(),
  ...timestamps,
});
export type InvoiceRule = z.infer<typeof invoiceRuleSchema>;
export const putInvoiceRuleSchema = z.object({
  purchaseOrderRequirement: documentRequirementSchema,
  hesRequirement: documentRequirementSchema,
  contractRequirement: documentRequirementSchema,
  supplierNumber: z.string().trim().max(120).nullable().default(null),
  defaultIssuerCompanyId: id.nullable().default(null),
  defaultTaxTreatment: taxTreatmentSchema.nullable().default(null),
  excelTemplateVariant: excelTemplateVariantSchema,
  billingNotes: z.string().trim().max(2000).nullable().default(null),
  isActive: z.boolean().default(true),
});
export type PutInvoiceRule = z.infer<typeof putInvoiceRuleSchema>;

export const receiverSchema = z.object({
  id,
  clientId: id,
  displayName: z.string().nullable(),
  email: z.string().email(),
  isActive: z.boolean(),
  ...timestamps,
});
export type Receiver = z.infer<typeof receiverSchema>;
export const createReceiverSchema = z.object({
  displayName: z.string().trim().max(120).nullable().default(null),
  email: z.string().trim().email().max(254),
});
export type CreateReceiver = z.infer<typeof createReceiverSchema>;
export const updateReceiverSchema = createReceiverSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Debe indicar al menos un cambio');
export type UpdateReceiver = z.infer<typeof updateReceiverSchema>;

export const productSchema = z.object({
  id,
  code: z.string().nullable(),
  name: z.string(),
  isActive: z.boolean(),
  ...timestamps,
});
export type Product = z.infer<typeof productSchema>;
export const createProductSchema = z.object({
  code: z.string().trim().min(1).max(32).nullable().default(null),
  name: nonEmpty(160),
});
export type CreateProduct = z.infer<typeof createProductSchema>;
export const updateProductSchema = createProductSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Debe indicar al menos un cambio');
export type UpdateProduct = z.infer<typeof updateProductSchema>;

export const projectCenterSchema = z.object({
  id,
  clientId: id,
  productId: id.nullable(),
  productName: z.string().nullable(),
  code: z.string(),
  projectName: z.string(),
  projectCenterType: projectCenterTypeSchema,
  isActive: z.boolean(),
  ...timestamps,
});
export type ProjectCenter = z.infer<typeof projectCenterSchema>;
export const createProjectCenterSchema = z.object({
  productId: id.nullable().default(null),
  code: nonEmpty(64),
  projectName: nonEmpty(200),
  projectCenterType: projectCenterTypeSchema,
});
export type CreateProjectCenter = z.infer<typeof createProjectCenterSchema>;
export const updateProjectCenterSchema = createProjectCenterSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Debe indicar al menos un cambio');
export type UpdateProjectCenter = z.infer<typeof updateProjectCenterSchema>;

export const clientDetailSchema = clientSchema.extend({
  invoiceRule: invoiceRuleSchema.nullable(),
});
export type ClientDetail = z.infer<typeof clientDetailSchema>;

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });
}

export const issuerCompaniesPageSchema = paginatedSchema(issuerCompanySchema);
export const coordinatorsPageSchema = paginatedSchema(coordinatorProfileSchema);
export const clientsPageSchema = paginatedSchema(clientSchema);
export const productsPageSchema = paginatedSchema(productSchema);
export const receiversPageSchema = paginatedSchema(receiverSchema);
export const projectCentersPageSchema = paginatedSchema(projectCenterSchema);

export const issuerCompanyResponseSchema = z.object({ issuerCompany: issuerCompanySchema });
export const coordinatorResponseSchema = z.object({ coordinator: coordinatorProfileSchema });
export const clientResponseSchema = z.object({ client: clientDetailSchema });
export const invoiceRuleResponseSchema = z.object({ invoiceRule: invoiceRuleSchema });
export const receiverResponseSchema = z.object({ receiver: receiverSchema });
export const productResponseSchema = z.object({ product: productSchema });
export const projectCenterResponseSchema = z.object({ projectCenter: projectCenterSchema });
