import type { LegacyMasterImportPayload, LegacyMasterImportRun } from '@factuflow/shared-schemas';
import type { AuthenticatedSession, RequestContext } from '../auth/identity-service.js';

export interface MasterImportService {
  preview(
    actor: AuthenticatedSession,
    input: LegacyMasterImportPayload,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<LegacyMasterImportRun>;

  apply(
    actor: AuthenticatedSession,
    input: LegacyMasterImportPayload,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<LegacyMasterImportRun>;

  get(actor: AuthenticatedSession, id: string): Promise<LegacyMasterImportRun>;
}
