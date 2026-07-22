import type {
  ExcelTemplateVariant,
  InvoiceRequestDetail,
  InvoiceRequestDuplicateSource,
  InvoiceRequestExportInput,
  InvoiceRequestListItem,
  InvoiceRequestListQuery,
  TaxTreatment,
} from '@factuflow/shared-schemas';
import type { AuthenticatedSession, RequestContext } from '../auth/identity-service.js';

export interface InvoiceWorkbookLine {
  readonly position: number;
  readonly projectCenterCode: string;
  readonly projectName: string;
  readonly productName: string | null;
  readonly ufAmount: string;
  readonly clpAmount: string;
}

export interface InvoiceWorkbookReceiver {
  readonly position: number;
  readonly displayName: string | null;
  readonly email: string;
}

export interface InvoiceWorkbookData {
  readonly templateVariant: ExcelTemplateVariant;
  readonly issuerLegalName: string;
  readonly clientShortName: string;
  readonly clientLegalName: string;
  readonly clientTaxId: string;
  readonly clientBusinessActivity: string;
  readonly clientAddress: string;
  readonly purchaseOrderNumber: string | null;
  readonly contractNumber: string | null;
  readonly hesNumber: string | null;
  readonly supplierNumber: string | null;
  readonly description: string;
  readonly observations: string | null;
  readonly area: 'Plataformas';
  readonly coordinatorDisplayName: string;
  readonly requestDate: string;
  readonly billingDate: string;
  readonly period: string;
  readonly ufDate: string;
  readonly ufValue: string;
  readonly taxTreatment: TaxTreatment;
  readonly netClp: string;
  readonly ivaClp: string;
  readonly totalClp: string;
  readonly lines: readonly InvoiceWorkbookLine[];
  readonly receivers: readonly InvoiceWorkbookReceiver[];
}

export interface GeneratedInvoiceWorkbook {
  readonly bytes: Uint8Array;
  readonly mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  readonly templateVersion: string;
}

export interface InvoiceWorkbookRenderer {
  generateAndValidate(data: InvoiceWorkbookData): Promise<GeneratedInvoiceWorkbook>;
}

export interface InvoiceExportResult {
  readonly invoiceRequestId: string;
  readonly folio: string;
  readonly filename: string;
  readonly mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface InvoiceRequestsPage {
  readonly items: InvoiceRequestListItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface InvoiceRequestService {
  exportAndPersist(
    input: InvoiceRequestExportInput,
    idempotencyKey: string,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<InvoiceExportResult>;
  list(query: InvoiceRequestListQuery): Promise<InvoiceRequestsPage>;
  get(id: string): Promise<InvoiceRequestDetail>;
  duplicateSource(id: string): Promise<InvoiceRequestDuplicateSource>;
  download(
    id: string,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<InvoiceExportResult>;
}
