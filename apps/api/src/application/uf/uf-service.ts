import type {
  InvoicePreviewRequest,
  InvoicePreviewResponse,
  UfValue,
} from '@factuflow/shared-schemas';
import type { AuthenticatedSession, RequestContext } from '../auth/identity-service.js';

export interface UfService {
  get(date: string, actor: AuthenticatedSession, context: RequestContext): Promise<UfValue>;
  refresh(date: string, actor: AuthenticatedSession, context: RequestContext): Promise<UfValue>;
}

export interface InvoicePreviewService {
  preview(
    input: InvoicePreviewRequest,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<InvoicePreviewResponse>;
}
