import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { type Insertable, type Kysely, type Transaction } from 'kysely';
import type {
  LegacyClientImport,
  LegacyClientInvoiceRuleImport,
  LegacyCoordinatorImport,
  LegacyImportEntity,
  LegacyImportStatus,
  LegacyIssuerCompanyImport,
  LegacyMasterImportIssue,
  LegacyMasterImportItem,
  LegacyMasterImportPayload,
  LegacyMasterImportRun,
  LegacyProductImport,
  LegacyProjectCenterImport,
  LegacyReceiverImport,
} from '@factuflow/shared-schemas';
import type { MasterImportService } from '../../application/billing/master-import-service.js';
import type {
  AuthenticatedSession,
  RequestContext,
} from '../../application/auth/identity-service.js';
import { AppError } from '../../application/errors.js';
import { stableJson } from '../../domain/invoice-request/export-safety.js';
import { InvalidChileanRutError, normalizeChileanRut } from '../../domain/billing/chilean-rut.js';
import { normalizeProductName } from '../../domain/billing/product-name.js';
import type { Database, JsonValue, LegacyMasterImportOperation } from './schema.js';

type Executor = Kysely<Database> | Transaction<Database>;
type ImportEntity = Exclude<LegacyImportEntity, 'client_invoice_rule'>;

interface InternalItem extends Omit<LegacyMasterImportItem, 'before' | 'after'> {
  readonly before: JsonValue | null;
  readonly after: JsonValue | null;
}

interface Counts {
  create: number;
  update: number;
  noop: number;
  error: number;
}

interface ExistingRecord {
  readonly id: string;
  readonly comparable: Record<string, unknown>;
}

const ENTITIES = [
  'issuer_company',
  'coordinator_profile',
  'client',
  'client_invoice_rule',
  'receiver',
  'product',
  'project_center',
] as const satisfies readonly LegacyImportEntity[];

function hash(value: unknown): string {
  const json = stableJson(JSON.parse(JSON.stringify(value)) as unknown);
  return createHash('sha256').update(json).digest('hex');
}

function sha256(value: unknown): string {
  return hash(value);
}

function iso(value: Date): string {
  return value.toISOString();
}

function safe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toJsonb(value: unknown): JsonValue {
  return JSON.stringify(safe(value));
}

function fromJsonb<T>(value: JsonValue | null): T | null {
  if (value === null) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function nullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalRate(value: string): string {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    throw new AppError('INVALID_IVA_RATE', 'La tasa IVA no es válida.', 422);
  }
  if (decimal.isNegative() || decimal.greaterThan(1)) {
    throw new AppError('INVALID_IVA_RATE', 'La tasa IVA debe estar entre 0 y 1.', 422);
  }
  return decimal.toFixed(4);
}

function canonicalRut(value: string): string {
  try {
    return normalizeChileanRut(value);
  } catch (error) {
    if (error instanceof InvalidChileanRutError) {
      throw new AppError('INVALID_RUT', error.message, 422);
    }
    throw error;
  }
}

function issue(code: string, message: string): LegacyMasterImportIssue {
  return { code, message };
}

function isSame(left: unknown, right: unknown): boolean {
  return stableJson(safe(left)) === stableJson(safe(right));
}

function emptyCounts(): Counts {
  return { create: 0, update: 0, noop: 0, error: 0 };
}

function entitySummary(items: readonly InternalItem[]): LegacyMasterImportRun['summary'] {
  const byEntity = Object.fromEntries(ENTITIES.map((entity) => [entity, emptyCounts()])) as Record<
    LegacyImportEntity,
    Counts
  >;
  const total = emptyCounts();

  for (const item of items) {
    const key =
      item.operation === 'CREATE'
        ? 'create'
        : item.operation === 'UPDATE'
          ? 'update'
          : item.operation === 'NOOP'
            ? 'noop'
            : 'error';
    byEntity[item.entity][key] += 1;
    total[key] += 1;
  }

  return { ...total, total: items.length, byEntity };
}

function item(
  entity: LegacyImportEntity,
  rowNumber: number,
  externalId: string | null,
  operation: LegacyMasterImportOperation,
  targetId: string | null,
  before: unknown,
  after: unknown,
  issues: LegacyMasterImportIssue[] = [],
): InternalItem {
  return {
    entity,
    rowNumber,
    externalId,
    operation,
    targetId,
    issues,
    before: before === null ? null : safe(before),
    after: after === null ? null : safe(after),
  };
}

function errorItem(
  entity: LegacyImportEntity,
  rowNumber: number,
  externalId: string | null,
  issues: LegacyMasterImportIssue[],
  after: unknown = null,
): InternalItem {
  return item(entity, rowNumber, externalId, 'ERROR', null, null, after, issues);
}

export class PostgresMasterImportService implements MasterImportService {
  constructor(private readonly db: Kysely<Database>) {}

  async preview(
    actor: AuthenticatedSession,
    input: LegacyMasterImportPayload,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<LegacyMasterImportRun> {
    return this.execute('PREVIEW', actor, input, idempotencyKey, context);
  }

  async apply(
    actor: AuthenticatedSession,
    input: LegacyMasterImportPayload,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<LegacyMasterImportRun> {
    return this.execute('APPLY', actor, input, idempotencyKey, context);
  }

  async get(_actor: AuthenticatedSession, id: string): Promise<LegacyMasterImportRun> {
    return this.hydrateRun(id);
  }

  private async execute(
    mode: 'PREVIEW' | 'APPLY',
    actor: AuthenticatedSession,
    input: LegacyMasterImportPayload,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<LegacyMasterImportRun> {
    const payloadHash = sha256(input);
    const sourceName = input.sourceName.trim();
    const sourceSha256 = input.sourceSha256 ?? sha256({ ...input, sourceSha256: null });
    const existing = await this.findExistingRun(actor.user.id, idempotencyKey);

    if (existing) {
      if (existing.mode !== mode || existing.payload_hash !== payloadHash) {
        throw new AppError(
          'IMPORT_IDEMPOTENCY_CONFLICT',
          'La clave de idempotencia ya fue usada con otro payload o modo.',
          409,
        );
      }
      return this.hydrateRun(existing.id);
    }

    const planned = await this.plan(this.db, input, sourceName);
    const hasErrors = planned.some((plannedItem) => plannedItem.operation === 'ERROR');
    const status: LegacyImportStatus =
      mode === 'PREVIEW' ? 'PREVIEWED' : hasErrors ? 'REJECTED' : 'APPLIED';

    return this.db.transaction().execute(async (trx) => {
      const items =
        mode === 'APPLY' && !hasErrors
          ? await this.applyPayload(trx, input, sourceName, actor)
          : planned;
      const summary = entitySummary(items);
      const runRow = await this.insertRun(
        trx,
        actor,
        idempotencyKey,
        mode,
        status,
        sourceName,
        sourceSha256,
        payloadHash,
        summary,
        context,
      );
      await this.insertItems(trx, runRow.id, items);
      await this.auditRun(trx, actor, status, runRow.id, context, summary);
      return {
        id: runRow.id,
        mode,
        status,
        sourceName,
        sourceSha256,
        payloadHash,
        summary,
        createdAt: iso(runRow.created_at),
        items,
      };
    });
  }

  private async findExistingRun(actorUserId: string, idempotencyKey: string) {
    return this.db
      .selectFrom('legacy_master_import_run')
      .select(['id', 'mode', 'payload_hash'])
      .where('actor_user_id', '=', actorUserId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  private async hydrateRun(id: string): Promise<LegacyMasterImportRun> {
    const run = await this.db
      .selectFrom('legacy_master_import_run')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!run)
      throw new AppError('IMPORT_RUN_NOT_FOUND', 'La corrida de importación no existe.', 404);
    const rows = await this.db
      .selectFrom('legacy_master_import_item')
      .selectAll()
      .where('run_id', '=', id)
      .orderBy('entity')
      .orderBy('row_number')
      .execute();
    return {
      id: run.id,
      mode: run.mode,
      status: run.status,
      sourceName: run.source_name,
      sourceSha256: run.source_sha256,
      payloadHash: run.payload_hash,
      summary: run.summary as LegacyMasterImportRun['summary'],
      createdAt: iso(run.created_at),
      items: rows.map((row) => ({
        entity: row.entity,
        rowNumber: row.row_number,
        externalId: row.external_id,
        operation: row.operation,
        targetId: row.target_id,
        issues: fromJsonb<LegacyMasterImportIssue[]>(row.issues) ?? [],
        before: fromJsonb<unknown>(row.changes_before),
        after: fromJsonb<unknown>(row.changes_after),
      })),
    };
  }

  private async plan(
    executor: Executor,
    input: LegacyMasterImportPayload,
    sourceName: string,
  ): Promise<InternalItem[]> {
    const items: InternalItem[] = [];
    items.push(...this.duplicateIssues(input));

    const refs = await this.loadReferenceMaps(executor, input, sourceName);
    for (const [index, record] of input.issuerCompanies.entries()) {
      items.push(
        await this.planIssuer(executor, record, index + 1, sourceName, input.options.allowUpdates),
      );
    }
    for (const [index, record] of input.coordinators.entries()) {
      items.push(
        await this.planCoordinator(
          executor,
          record,
          index + 1,
          sourceName,
          input.options.allowUpdates,
        ),
      );
    }
    for (const [index, record] of input.products.entries()) {
      items.push(
        await this.planProduct(executor, record, index + 1, sourceName, input.options.allowUpdates),
      );
    }
    for (const [index, record] of input.clients.entries()) {
      items.push(
        await this.planClient(
          executor,
          record,
          index + 1,
          sourceName,
          refs,
          input.options.allowUpdates,
        ),
      );
    }
    for (const [index, record] of input.invoiceRules.entries()) {
      items.push(
        await this.planInvoiceRule(executor, record, index + 1, refs, input.options.allowUpdates),
      );
    }
    for (const [index, record] of input.receivers.entries()) {
      items.push(
        await this.planReceiver(
          executor,
          record,
          index + 1,
          sourceName,
          refs,
          input.options.allowUpdates,
        ),
      );
    }
    for (const [index, record] of input.projectCenters.entries()) {
      items.push(
        await this.planProjectCenter(
          executor,
          record,
          index + 1,
          sourceName,
          refs,
          input.options.allowUpdates,
        ),
      );
    }
    return items;
  }

  private duplicateIssues(input: LegacyMasterImportPayload): InternalItem[] {
    const items: InternalItem[] = [];
    const check = <T extends { externalId: string }>(
      entity: ImportEntity,
      records: readonly T[],
    ): void => {
      const seen = new Set<string>();
      records.forEach((record, index) => {
        const key = record.externalId.trim().toLowerCase();
        if (seen.has(key)) {
          items.push(
            errorItem(entity, index + 1, record.externalId, [
              issue('DUPLICATE_EXTERNAL_ID', 'El externalId se repite dentro del payload.'),
            ]),
          );
        }
        seen.add(key);
      });
    };
    check('issuer_company', input.issuerCompanies);
    check('coordinator_profile', input.coordinators);
    check('client', input.clients);
    check('receiver', input.receivers);
    check('product', input.products);
    check('project_center', input.projectCenters);
    return items;
  }

  private async loadReferenceMaps(
    executor: Executor,
    input: LegacyMasterImportPayload,
    sourceName: string,
  ): Promise<Map<string, { entity: ImportEntity; targetId: string | null; pending: boolean }>> {
    const refs = new Map<
      string,
      { entity: ImportEntity; targetId: string | null; pending: boolean }
    >();
    const addPending = (entity: ImportEntity, externalId: string) =>
      refs.set(`${entity}:${externalId}`, { entity, targetId: null, pending: true });
    input.issuerCompanies.forEach((record) => addPending('issuer_company', record.externalId));
    input.coordinators.forEach((record) => addPending('coordinator_profile', record.externalId));
    input.clients.forEach((record) => addPending('client', record.externalId));
    input.receivers.forEach((record) => addPending('receiver', record.externalId));
    input.products.forEach((record) => addPending('product', record.externalId));
    input.projectCenters.forEach((record) => addPending('project_center', record.externalId));

    const mappings = await executor
      .selectFrom('legacy_master_import_mapping')
      .selectAll()
      .where('source_name', '=', sourceName)
      .execute();
    for (const mapping of mappings) {
      refs.set(`${mapping.entity}:${mapping.external_id}`, {
        entity: mapping.entity,
        targetId: mapping.target_id,
        pending: false,
      });
    }
    return refs;
  }

  private ref(
    refs: Map<string, { entity: ImportEntity; targetId: string | null; pending: boolean }>,
    entity: ImportEntity,
    externalId: string | null,
  ): { targetId: string | null; pending: boolean } | null {
    if (!externalId) return null;
    return refs.get(`${entity}:${externalId}`) ?? null;
  }

  private async planIssuer(
    executor: Executor,
    record: LegacyIssuerCompanyImport,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
  ): Promise<InternalItem> {
    try {
      const desired = this.issuerDesired(record);
      const existing = await this.findIssuer(executor, sourceName, record.externalId, desired);
      return this.planExisting(
        'issuer_company',
        rowNumber,
        record.externalId,
        existing,
        desired,
        allowUpdates,
      );
    } catch (error) {
      return this.validationError('issuer_company', rowNumber, record.externalId, error, record);
    }
  }

  private async planCoordinator(
    executor: Executor,
    record: LegacyCoordinatorImport,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
  ): Promise<InternalItem> {
    const desired = this.coordinatorDesired(record);
    const existing = await this.findCoordinator(executor, sourceName, record.externalId, desired);
    return this.planExisting(
      'coordinator_profile',
      rowNumber,
      record.externalId,
      existing,
      desired,
      allowUpdates,
    );
  }

  private async planProduct(
    executor: Executor,
    record: LegacyProductImport,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
  ): Promise<InternalItem> {
    const desired = this.productDesired(record);
    const existing = await this.findProduct(executor, sourceName, record.externalId, desired);
    return this.planExisting(
      'product',
      rowNumber,
      record.externalId,
      existing,
      desired,
      allowUpdates,
    );
  }

  private async planClient(
    executor: Executor,
    record: LegacyClientImport,
    rowNumber: number,
    sourceName: string,
    refs: Map<string, { entity: ImportEntity; targetId: string | null; pending: boolean }>,
    allowUpdates: boolean,
  ): Promise<InternalItem> {
    try {
      const coordinatorRef = this.ref(
        refs,
        'coordinator_profile',
        record.defaultCoordinatorExternalId,
      );
      if (record.defaultCoordinatorExternalId && !coordinatorRef) {
        return errorItem('client', rowNumber, record.externalId, [
          issue(
            'COORDINATOR_REFERENCE_NOT_FOUND',
            'El responsable sugerido no existe en payload ni mapeos.',
          ),
        ]);
      }
      const desired = this.clientDesired(record, coordinatorRef?.targetId ?? null);
      const existing = await this.findClient(executor, sourceName, record.externalId, desired);
      return this.planExisting(
        'client',
        rowNumber,
        record.externalId,
        existing,
        desired,
        allowUpdates,
      );
    } catch (error) {
      return this.validationError('client', rowNumber, record.externalId, error, record);
    }
  }

  private async planInvoiceRule(
    executor: Executor,
    record: LegacyClientInvoiceRuleImport,
    rowNumber: number,
    refs: Map<string, { entity: ImportEntity; targetId: string | null; pending: boolean }>,
    allowUpdates: boolean,
  ): Promise<InternalItem> {
    const clientRef = this.ref(refs, 'client', record.clientExternalId);
    if (!clientRef) {
      return errorItem('client_invoice_rule', rowNumber, record.clientExternalId, [
        issue(
          'CLIENT_REFERENCE_NOT_FOUND',
          'El cliente de la regla no existe en payload ni mapeos.',
        ),
      ]);
    }
    const issuerRef = this.ref(refs, 'issuer_company', record.defaultIssuerCompanyExternalId);
    if (record.defaultIssuerCompanyExternalId && !issuerRef) {
      return errorItem('client_invoice_rule', rowNumber, record.clientExternalId, [
        issue('ISSUER_REFERENCE_NOT_FOUND', 'La emisora sugerida no existe en payload ni mapeos.'),
      ]);
    }
    if (clientRef.pending || issuerRef?.pending) {
      return item('client_invoice_rule', rowNumber, record.clientExternalId, 'CREATE', null, null, {
        ...this.invoiceRuleDesired(record, null, null),
        pendingReferences: true,
      });
    }
    const desired = this.invoiceRuleDesired(
      record,
      clientRef.targetId,
      issuerRef?.targetId ?? null,
    );
    const existing = await this.findInvoiceRule(executor, clientRef.targetId!);
    return this.planExisting(
      'client_invoice_rule',
      rowNumber,
      record.clientExternalId,
      existing,
      desired,
      allowUpdates,
    );
  }

  private async planReceiver(
    executor: Executor,
    record: LegacyReceiverImport,
    rowNumber: number,
    sourceName: string,
    refs: Map<string, { entity: ImportEntity; targetId: string | null; pending: boolean }>,
    allowUpdates: boolean,
  ): Promise<InternalItem> {
    const clientRef = this.ref(refs, 'client', record.clientExternalId);
    if (!clientRef) {
      return errorItem('receiver', rowNumber, record.externalId, [
        issue(
          'CLIENT_REFERENCE_NOT_FOUND',
          'El cliente del receptor no existe en payload ni mapeos.',
        ),
      ]);
    }
    if (clientRef.pending) {
      return item('receiver', rowNumber, record.externalId, 'CREATE', null, null, {
        ...this.receiverDesired(record, null),
        pendingReferences: true,
      });
    }
    const desired = this.receiverDesired(record, clientRef.targetId);
    const existing = await this.findReceiver(executor, sourceName, record.externalId, desired);
    return this.planExisting(
      'receiver',
      rowNumber,
      record.externalId,
      existing,
      desired,
      allowUpdates,
    );
  }

  private async planProjectCenter(
    executor: Executor,
    record: LegacyProjectCenterImport,
    rowNumber: number,
    sourceName: string,
    refs: Map<string, { entity: ImportEntity; targetId: string | null; pending: boolean }>,
    allowUpdates: boolean,
  ): Promise<InternalItem> {
    const clientRef = this.ref(refs, 'client', record.clientExternalId);
    const productRef = this.ref(refs, 'product', record.productExternalId);
    if (!clientRef || !productRef) {
      return errorItem('project_center', rowNumber, record.externalId, [
        issue(
          'PROJECT_CENTER_REFERENCE_NOT_FOUND',
          'El cliente o producto del CP/MS no existe en payload ni mapeos.',
        ),
      ]);
    }
    if (clientRef.pending || productRef.pending) {
      return item('project_center', rowNumber, record.externalId, 'CREATE', null, null, {
        ...this.projectCenterDesired(record, null, null),
        pendingReferences: true,
      });
    }
    const desired = this.projectCenterDesired(record, clientRef.targetId, productRef.targetId);
    const existing = await this.findProjectCenter(executor, sourceName, record.externalId, desired);
    return this.planExisting(
      'project_center',
      rowNumber,
      record.externalId,
      existing,
      desired,
      allowUpdates,
    );
  }

  private planExisting(
    entity: LegacyImportEntity,
    rowNumber: number,
    externalId: string,
    existing: ExistingRecord | null,
    desired: Record<string, unknown>,
    allowUpdates: boolean,
  ): InternalItem {
    if (!existing) return item(entity, rowNumber, externalId, 'CREATE', null, null, desired);
    if (isSame(existing.comparable, desired)) {
      return item(entity, rowNumber, externalId, 'NOOP', existing.id, existing.comparable, desired);
    }
    if (!allowUpdates) {
      return errorItem(
        entity,
        rowNumber,
        externalId,
        [issue('UPDATE_NOT_ALLOWED', 'El registro existe con diferencias y allowUpdates=false.')],
        desired,
      );
    }
    return item(entity, rowNumber, externalId, 'UPDATE', existing.id, existing.comparable, desired);
  }

  private validationError(
    entity: LegacyImportEntity,
    rowNumber: number,
    externalId: string,
    error: unknown,
    after: unknown,
  ): InternalItem {
    if (error instanceof AppError) {
      return errorItem(entity, rowNumber, externalId, [issue(error.code, error.message)], after);
    }
    throw error;
  }

  private async applyPayload(
    trx: Transaction<Database>,
    input: LegacyMasterImportPayload,
    sourceName: string,
    actor: AuthenticatedSession,
  ): Promise<InternalItem[]> {
    const items: InternalItem[] = [];
    const refs = new Map<string, string>();
    const remember = (entity: ImportEntity, externalId: string, targetId: string) => {
      refs.set(`${entity}:${externalId}`, targetId);
    };
    const mapped = async (entity: ImportEntity, externalId: string): Promise<string | null> => {
      const local = refs.get(`${entity}:${externalId}`);
      if (local) return local;
      const row = await this.mapping(trx, entity, sourceName, externalId);
      return row?.target_id ?? null;
    };

    for (const [index, record] of input.issuerCompanies.entries()) {
      const result = await this.upsertIssuer(
        trx,
        record,
        index + 1,
        sourceName,
        input.options.allowUpdates,
        actor,
      );
      items.push(result);
      if (result.targetId) remember('issuer_company', record.externalId, result.targetId);
    }
    for (const [index, record] of input.coordinators.entries()) {
      const result = await this.upsertCoordinator(
        trx,
        record,
        index + 1,
        sourceName,
        input.options.allowUpdates,
        actor,
      );
      items.push(result);
      if (result.targetId) remember('coordinator_profile', record.externalId, result.targetId);
    }
    for (const [index, record] of input.products.entries()) {
      const result = await this.upsertProduct(
        trx,
        record,
        index + 1,
        sourceName,
        input.options.allowUpdates,
        actor,
      );
      items.push(result);
      if (result.targetId) remember('product', record.externalId, result.targetId);
    }
    for (const [index, record] of input.clients.entries()) {
      const coordinatorId = record.defaultCoordinatorExternalId
        ? await mapped('coordinator_profile', record.defaultCoordinatorExternalId)
        : null;
      const result = await this.upsertClient(
        trx,
        record,
        coordinatorId,
        index + 1,
        sourceName,
        input.options.allowUpdates,
        actor,
      );
      items.push(result);
      if (result.targetId) remember('client', record.externalId, result.targetId);
    }
    for (const [index, record] of input.invoiceRules.entries()) {
      const clientId = await mapped('client', record.clientExternalId);
      const issuerId = record.defaultIssuerCompanyExternalId
        ? await mapped('issuer_company', record.defaultIssuerCompanyExternalId)
        : null;
      const result = await this.upsertInvoiceRule(
        trx,
        record,
        clientId,
        issuerId,
        index + 1,
        input.options.allowUpdates,
        actor,
      );
      items.push(result);
    }
    for (const [index, record] of input.receivers.entries()) {
      const clientId = await mapped('client', record.clientExternalId);
      const result = await this.upsertReceiver(
        trx,
        record,
        clientId,
        index + 1,
        sourceName,
        input.options.allowUpdates,
        actor,
      );
      items.push(result);
      if (result.targetId) remember('receiver', record.externalId, result.targetId);
    }
    for (const [index, record] of input.projectCenters.entries()) {
      const clientId = await mapped('client', record.clientExternalId);
      const productId = await mapped('product', record.productExternalId);
      const result = await this.upsertProjectCenter(
        trx,
        record,
        clientId,
        productId,
        index + 1,
        sourceName,
        input.options.allowUpdates,
        actor,
      );
      items.push(result);
      if (result.targetId) remember('project_center', record.externalId, result.targetId);
    }

    return items;
  }

  private issuerDesired(record: LegacyIssuerCompanyImport): Record<string, unknown> {
    return {
      code: record.code.trim(),
      legal_name: record.legalName.trim(),
      tax_id: canonicalRut(record.taxId),
      business_activity: record.businessActivity.trim(),
      address: record.address.trim(),
      default_tax_treatment: record.defaultTaxTreatment,
      default_iva_rate: canonicalRate(record.defaultIvaRate),
      is_active: record.isActive,
    };
  }

  private coordinatorDesired(record: LegacyCoordinatorImport): Record<string, unknown> {
    return {
      app_user_id: null,
      display_name: record.displayName.trim(),
      email: nullable(record.email)?.toLowerCase() ?? null,
      is_active: record.isActive,
    };
  }

  private productDesired(record: LegacyProductImport): Record<string, unknown> {
    return {
      code: nullable(record.code),
      name: record.name.trim(),
      normalized_name: normalizeProductName(record.name),
      is_active: record.isActive,
    };
  }

  private clientDesired(
    record: LegacyClientImport,
    coordinatorId: string | null,
  ): Record<string, unknown> {
    return {
      short_name: record.shortName.trim(),
      legal_name: nullable(record.legalName),
      tax_id: record.taxId ? canonicalRut(record.taxId) : null,
      business_activity: nullable(record.businessActivity),
      address: nullable(record.address),
      default_coordinator_profile_id: coordinatorId,
      data_status: record.dataStatus,
      is_active: record.isActive,
    };
  }

  private invoiceRuleDesired(
    record: LegacyClientInvoiceRuleImport,
    clientId: string | null,
    issuerId: string | null,
  ): Record<string, unknown> {
    return {
      client_id: clientId,
      purchase_order_requirement: record.purchaseOrderRequirement,
      hes_requirement: record.hesRequirement,
      contract_requirement: record.contractRequirement,
      supplier_number: nullable(record.supplierNumber),
      default_issuer_company_id: issuerId,
      default_tax_treatment: record.defaultTaxTreatment,
      excel_template_variant: record.excelTemplateVariant,
      billing_notes: nullable(record.billingNotes),
      is_active: record.isActive,
    };
  }

  private receiverDesired(
    record: LegacyReceiverImport,
    clientId: string | null,
  ): Record<string, unknown> {
    return {
      client_id: clientId,
      display_name: nullable(record.displayName),
      email: lower(record.email),
      is_active: record.isActive,
    };
  }

  private projectCenterDesired(
    record: LegacyProjectCenterImport,
    clientId: string | null,
    productId: string | null,
  ): Record<string, unknown> {
    return {
      client_id: clientId,
      product_id: productId,
      code: record.code.trim(),
      project_name: record.projectName.trim(),
      project_center_type: record.projectCenterType,
      is_active: record.isActive,
    };
  }

  private rowComparable(
    row: Record<string, unknown>,
    keys: readonly string[],
  ): Record<string, unknown> {
    return Object.fromEntries(keys.map((key) => [key, row[key]]));
  }

  private async mapping(
    executor: Executor,
    entity: ImportEntity,
    sourceName: string,
    externalId: string,
  ) {
    return executor
      .selectFrom('legacy_master_import_mapping')
      .selectAll()
      .where('entity', '=', entity)
      .where('source_name', '=', sourceName)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
  }

  private async ensureMapping(
    trx: Transaction<Database>,
    entity: ImportEntity,
    sourceName: string,
    externalId: string,
    targetId: string,
  ): Promise<void> {
    await trx
      .insertInto('legacy_master_import_mapping')
      .values({ entity, source_name: sourceName, external_id: externalId, target_id: targetId })
      .onConflict((conflict) =>
        conflict.columns(['entity', 'source_name', 'external_id']).doNothing(),
      )
      .execute();
  }

  private async findByMappedId(
    executor: Executor,
    entity: ImportEntity,
    sourceName: string,
    externalId: string,
    table: ImportEntity,
    keys: readonly string[],
  ): Promise<ExistingRecord | null> {
    const mapped = await this.mapping(executor, entity, sourceName, externalId);
    if (!mapped) return null;
    const row = await executor
      .selectFrom(table)
      .selectAll()
      .where('id', '=', mapped.target_id)
      .executeTakeFirst();
    if (!row) {
      return {
        id: mapped.target_id,
        comparable: { mappingError: 'target_missing' },
      };
    }
    return { id: mapped.target_id, comparable: this.rowComparable(row, keys) };
  }

  private async findIssuer(
    executor: Executor,
    sourceName: string,
    externalId: string,
    desired: Record<string, unknown>,
  ): Promise<ExistingRecord | null> {
    const keys = Object.keys(desired);
    const mapped = await this.findByMappedId(
      executor,
      'issuer_company',
      sourceName,
      externalId,
      'issuer_company',
      keys,
    );
    if (mapped) return mapped;
    const rows = await executor
      .selectFrom('issuer_company')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('code', '=', String(desired['code'])),
          eb('tax_id', '=', String(desired['tax_id'])),
        ]),
      )
      .execute();
    return this.singleNatural('issuer_company', rows, keys);
  }

  private async findCoordinator(
    executor: Executor,
    sourceName: string,
    externalId: string,
    desired: Record<string, unknown>,
  ): Promise<ExistingRecord | null> {
    const keys = Object.keys(desired);
    const mapped = await this.findByMappedId(
      executor,
      'coordinator_profile',
      sourceName,
      externalId,
      'coordinator_profile',
      keys,
    );
    if (mapped) return mapped;
    const email = typeof desired['email'] === 'string' ? desired['email'] : null;
    const displayName = typeof desired['display_name'] === 'string' ? desired['display_name'] : '';
    const rows = email
      ? await executor
          .selectFrom('coordinator_profile')
          .selectAll()
          .where('email', '=', email)
          .execute()
      : await executor
          .selectFrom('coordinator_profile')
          .selectAll()
          .where('display_name', '=', displayName)
          .execute();
    return this.singleNatural('coordinator_profile', rows, keys);
  }

  private async findProduct(
    executor: Executor,
    sourceName: string,
    externalId: string,
    desired: Record<string, unknown>,
  ): Promise<ExistingRecord | null> {
    const keys = Object.keys(desired);
    const mapped = await this.findByMappedId(
      executor,
      'product',
      sourceName,
      externalId,
      'product',
      keys,
    );
    if (mapped) return mapped;
    const normalizedName =
      typeof desired['normalized_name'] === 'string' ? desired['normalized_name'] : '';
    const code = typeof desired['code'] === 'string' ? desired['code'] : null;
    const rows = await executor
      .selectFrom('product')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('normalized_name', '=', normalizedName),
          ...(code ? [eb('code', '=', code)] : []),
        ]),
      )
      .execute();
    return this.singleNatural('product', rows, keys);
  }

  private async findClient(
    executor: Executor,
    sourceName: string,
    externalId: string,
    desired: Record<string, unknown>,
  ): Promise<ExistingRecord | null> {
    const keys = Object.keys(desired);
    const mapped = await this.findByMappedId(
      executor,
      'client',
      sourceName,
      externalId,
      'client',
      keys,
    );
    if (mapped) return mapped;
    const shortName = typeof desired['short_name'] === 'string' ? desired['short_name'] : '';
    const taxId = typeof desired['tax_id'] === 'string' ? desired['tax_id'] : null;
    const rows = await executor
      .selectFrom('client')
      .selectAll()
      .where((eb) =>
        eb.or([eb('short_name', '=', shortName), ...(taxId ? [eb('tax_id', '=', taxId)] : [])]),
      )
      .execute();
    return this.singleNatural('client', rows, keys);
  }

  private async findInvoiceRule(
    executor: Executor,
    clientId: string,
  ): Promise<ExistingRecord | null> {
    const row = await executor
      .selectFrom('client_invoice_rule')
      .selectAll()
      .where('client_id', '=', clientId)
      .executeTakeFirst();
    if (!row) return null;
    const keys = [
      'client_id',
      'purchase_order_requirement',
      'hes_requirement',
      'contract_requirement',
      'supplier_number',
      'default_issuer_company_id',
      'default_tax_treatment',
      'excel_template_variant',
      'billing_notes',
      'is_active',
    ];
    return { id: clientId, comparable: this.rowComparable(row, keys) };
  }

  private async findReceiver(
    executor: Executor,
    sourceName: string,
    externalId: string,
    desired: Record<string, unknown>,
  ): Promise<ExistingRecord | null> {
    const keys = Object.keys(desired);
    const mapped = await this.findByMappedId(
      executor,
      'receiver',
      sourceName,
      externalId,
      'receiver',
      keys,
    );
    if (mapped) return mapped;
    const row = await executor
      .selectFrom('receiver')
      .selectAll()
      .where('client_id', '=', String(desired['client_id']))
      .where('email', '=', String(desired['email']))
      .executeTakeFirst();
    return row ? { id: row.id, comparable: this.rowComparable(row, keys) } : null;
  }

  private async findProjectCenter(
    executor: Executor,
    sourceName: string,
    externalId: string,
    desired: Record<string, unknown>,
  ): Promise<ExistingRecord | null> {
    const keys = Object.keys(desired);
    const mapped = await this.findByMappedId(
      executor,
      'project_center',
      sourceName,
      externalId,
      'project_center',
      keys,
    );
    if (mapped) return mapped;
    const row = await executor
      .selectFrom('project_center')
      .selectAll()
      .where('client_id', '=', String(desired['client_id']))
      .where('code', '=', String(desired['code']))
      .executeTakeFirst();
    return row ? { id: row.id, comparable: this.rowComparable(row, keys) } : null;
  }

  private singleNatural(
    entity: LegacyImportEntity,
    rows: readonly Record<string, unknown>[],
    keys: readonly string[],
  ): ExistingRecord | null {
    const ids = new Set(rows.map((row) => String(row['id'])));
    if (ids.size > 1) {
      throw new AppError(
        'IMPORT_NATURAL_KEY_CONFLICT',
        `La búsqueda natural para ${entity} encontró más de un destino.`,
        409,
      );
    }
    const row = rows[0];
    return row ? { id: String(row['id']), comparable: this.rowComparable(row, keys) } : null;
  }

  private async upsertIssuer(
    trx: Transaction<Database>,
    record: LegacyIssuerCompanyImport,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
    actor: AuthenticatedSession,
  ): Promise<InternalItem> {
    const desired = this.issuerDesired(record);
    const existing = await this.findIssuer(trx, sourceName, record.externalId, desired);
    if (existing && !isSame(existing.comparable, desired) && !allowUpdates) {
      return errorItem(
        'issuer_company',
        rowNumber,
        record.externalId,
        [issue('UPDATE_NOT_ALLOWED', 'El registro existe con diferencias y allowUpdates=false.')],
        desired,
      );
    }
    if (existing && isSame(existing.comparable, desired)) {
      await this.ensureMapping(trx, 'issuer_company', sourceName, record.externalId, existing.id);
      return item(
        'issuer_company',
        rowNumber,
        record.externalId,
        'NOOP',
        existing.id,
        existing.comparable,
        desired,
      );
    }
    const row = existing
      ? await trx
          .updateTable('issuer_company')
          .set(desired)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('issuer_company')
          .values({ ...desired, created_by: actor.user.id } as Insertable<
            Database['issuer_company']
          >)
          .returningAll()
          .executeTakeFirstOrThrow();
    await this.ensureMapping(trx, 'issuer_company', sourceName, record.externalId, row.id);
    return item(
      'issuer_company',
      rowNumber,
      record.externalId,
      existing ? 'UPDATE' : 'CREATE',
      row.id,
      existing?.comparable ?? null,
      desired,
    );
  }

  private async upsertCoordinator(
    trx: Transaction<Database>,
    record: LegacyCoordinatorImport,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
    actor: AuthenticatedSession,
  ): Promise<InternalItem> {
    const desired = this.coordinatorDesired(record);
    const existing = await this.findCoordinator(trx, sourceName, record.externalId, desired);
    if (existing && !isSame(existing.comparable, desired) && !allowUpdates) {
      return errorItem(
        'coordinator_profile',
        rowNumber,
        record.externalId,
        [
          issue(
            'UPDATE_NOT_ALLOWED',
            'El responsable existe con diferencias y allowUpdates=false.',
          ),
        ],
        desired,
      );
    }
    if (existing && isSame(existing.comparable, desired)) {
      await this.ensureMapping(
        trx,
        'coordinator_profile',
        sourceName,
        record.externalId,
        existing.id,
      );
      return item(
        'coordinator_profile',
        rowNumber,
        record.externalId,
        'NOOP',
        existing.id,
        existing.comparable,
        desired,
      );
    }
    const row = existing
      ? await trx
          .updateTable('coordinator_profile')
          .set(desired)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('coordinator_profile')
          .values({
            ...desired,
            created_by: actor.user.id,
          } as Insertable<Database['coordinator_profile']>)
          .returningAll()
          .executeTakeFirstOrThrow();
    await this.ensureMapping(trx, 'coordinator_profile', sourceName, record.externalId, row.id);
    return item(
      'coordinator_profile',
      rowNumber,
      record.externalId,
      existing ? 'UPDATE' : 'CREATE',
      row.id,
      existing?.comparable ?? null,
      desired,
    );
  }

  private async upsertProduct(
    trx: Transaction<Database>,
    record: LegacyProductImport,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
    actor: AuthenticatedSession,
  ): Promise<InternalItem> {
    const desired = this.productDesired(record);
    const existing = await this.findProduct(trx, sourceName, record.externalId, desired);
    if (existing && !isSame(existing.comparable, desired) && !allowUpdates) {
      return errorItem(
        'product',
        rowNumber,
        record.externalId,
        [issue('UPDATE_NOT_ALLOWED', 'El producto existe con diferencias y allowUpdates=false.')],
        desired,
      );
    }
    if (existing && isSame(existing.comparable, desired)) {
      await this.ensureMapping(trx, 'product', sourceName, record.externalId, existing.id);
      return item(
        'product',
        rowNumber,
        record.externalId,
        'NOOP',
        existing.id,
        existing.comparable,
        desired,
      );
    }
    const row = existing
      ? await trx
          .updateTable('product')
          .set(desired)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('product')
          .values({ ...desired, created_by: actor.user.id } as Insertable<Database['product']>)
          .returningAll()
          .executeTakeFirstOrThrow();
    await this.ensureMapping(trx, 'product', sourceName, record.externalId, row.id);
    return item(
      'product',
      rowNumber,
      record.externalId,
      existing ? 'UPDATE' : 'CREATE',
      row.id,
      existing?.comparable ?? null,
      desired,
    );
  }

  private async upsertClient(
    trx: Transaction<Database>,
    record: LegacyClientImport,
    coordinatorId: string | null,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
    actor: AuthenticatedSession,
  ): Promise<InternalItem> {
    const desired = this.clientDesired(record, coordinatorId);
    const existing = await this.findClient(trx, sourceName, record.externalId, desired);
    if (existing && !isSame(existing.comparable, desired) && !allowUpdates) {
      return errorItem(
        'client',
        rowNumber,
        record.externalId,
        [issue('UPDATE_NOT_ALLOWED', 'El cliente existe con diferencias y allowUpdates=false.')],
        desired,
      );
    }
    if (existing && isSame(existing.comparable, desired)) {
      await this.ensureMapping(trx, 'client', sourceName, record.externalId, existing.id);
      return item(
        'client',
        rowNumber,
        record.externalId,
        'NOOP',
        existing.id,
        existing.comparable,
        desired,
      );
    }
    const values = { ...desired, updated_by: actor.user.id };
    const row = existing
      ? await trx
          .updateTable('client')
          .set(values)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('client')
          .values({ ...values, created_by: actor.user.id } as Insertable<Database['client']>)
          .returningAll()
          .executeTakeFirstOrThrow();
    await this.ensureMapping(trx, 'client', sourceName, record.externalId, row.id);
    return item(
      'client',
      rowNumber,
      record.externalId,
      existing ? 'UPDATE' : 'CREATE',
      row.id,
      existing?.comparable ?? null,
      desired,
    );
  }

  private async upsertInvoiceRule(
    trx: Transaction<Database>,
    record: LegacyClientInvoiceRuleImport,
    clientId: string | null,
    issuerId: string | null,
    rowNumber: number,
    allowUpdates: boolean,
    actor: AuthenticatedSession,
  ): Promise<InternalItem> {
    if (!clientId) {
      return errorItem('client_invoice_rule', rowNumber, record.clientExternalId, [
        issue('CLIENT_REFERENCE_NOT_FOUND', 'El cliente de la regla no se pudo resolver.'),
      ]);
    }
    const desired = this.invoiceRuleDesired(record, clientId, issuerId);
    const existing = await this.findInvoiceRule(trx, clientId);
    if (existing && !isSame(existing.comparable, desired) && !allowUpdates) {
      return errorItem(
        'client_invoice_rule',
        rowNumber,
        record.clientExternalId,
        [
          issue(
            'UPDATE_NOT_ALLOWED',
            'La regla de facturación existe con diferencias y allowUpdates=false.',
          ),
        ],
        desired,
      );
    }
    if (existing && isSame(existing.comparable, desired)) {
      return item(
        'client_invoice_rule',
        rowNumber,
        record.clientExternalId,
        'NOOP',
        clientId,
        existing.comparable,
        desired,
      );
    }
    const values = { ...desired, updated_by: actor.user.id };
    if (existing) {
      await trx
        .updateTable('client_invoice_rule')
        .set(values)
        .where('client_id', '=', clientId)
        .execute();
    } else {
      await trx
        .insertInto('client_invoice_rule')
        .values({
          ...values,
          client_id: clientId,
          created_by: actor.user.id,
        } as Insertable<Database['client_invoice_rule']>)
        .execute();
    }
    return item(
      'client_invoice_rule',
      rowNumber,
      record.clientExternalId,
      existing ? 'UPDATE' : 'CREATE',
      clientId,
      existing?.comparable ?? null,
      desired,
    );
  }

  private async upsertReceiver(
    trx: Transaction<Database>,
    record: LegacyReceiverImport,
    clientId: string | null,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
    actor: AuthenticatedSession,
  ): Promise<InternalItem> {
    if (!clientId) {
      return errorItem('receiver', rowNumber, record.externalId, [
        issue('CLIENT_REFERENCE_NOT_FOUND', 'El cliente del receptor no se pudo resolver.'),
      ]);
    }
    const desired = this.receiverDesired(record, clientId);
    const existing = await this.findReceiver(trx, sourceName, record.externalId, desired);
    if (existing && !isSame(existing.comparable, desired) && !allowUpdates) {
      return errorItem(
        'receiver',
        rowNumber,
        record.externalId,
        [issue('UPDATE_NOT_ALLOWED', 'El receptor existe con diferencias y allowUpdates=false.')],
        desired,
      );
    }
    if (existing && isSame(existing.comparable, desired)) {
      await this.ensureMapping(trx, 'receiver', sourceName, record.externalId, existing.id);
      return item(
        'receiver',
        rowNumber,
        record.externalId,
        'NOOP',
        existing.id,
        existing.comparable,
        desired,
      );
    }
    const row = existing
      ? await trx
          .updateTable('receiver')
          .set(desired)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('receiver')
          .values({ ...desired, created_by: actor.user.id } as Insertable<Database['receiver']>)
          .returningAll()
          .executeTakeFirstOrThrow();
    await this.ensureMapping(trx, 'receiver', sourceName, record.externalId, row.id);
    return item(
      'receiver',
      rowNumber,
      record.externalId,
      existing ? 'UPDATE' : 'CREATE',
      row.id,
      existing?.comparable ?? null,
      desired,
    );
  }

  private async upsertProjectCenter(
    trx: Transaction<Database>,
    record: LegacyProjectCenterImport,
    clientId: string | null,
    productId: string | null,
    rowNumber: number,
    sourceName: string,
    allowUpdates: boolean,
    actor: AuthenticatedSession,
  ): Promise<InternalItem> {
    if (!clientId || !productId) {
      return errorItem('project_center', rowNumber, record.externalId, [
        issue(
          'PROJECT_CENTER_REFERENCE_NOT_FOUND',
          'El cliente o producto del CP/MS no se pudo resolver.',
        ),
      ]);
    }
    const desired = this.projectCenterDesired(record, clientId, productId);
    const existing = await this.findProjectCenter(trx, sourceName, record.externalId, desired);
    if (existing && !isSame(existing.comparable, desired) && !allowUpdates) {
      return errorItem(
        'project_center',
        rowNumber,
        record.externalId,
        [issue('UPDATE_NOT_ALLOWED', 'El CP/MS existe con diferencias y allowUpdates=false.')],
        desired,
      );
    }
    if (existing && isSame(existing.comparable, desired)) {
      await this.ensureMapping(trx, 'project_center', sourceName, record.externalId, existing.id);
      return item(
        'project_center',
        rowNumber,
        record.externalId,
        'NOOP',
        existing.id,
        existing.comparable,
        desired,
      );
    }
    const row = existing
      ? await trx
          .updateTable('project_center')
          .set(desired)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('project_center')
          .values({
            ...desired,
            created_by: actor.user.id,
          } as Insertable<Database['project_center']>)
          .returningAll()
          .executeTakeFirstOrThrow();
    await this.ensureMapping(trx, 'project_center', sourceName, record.externalId, row.id);
    return item(
      'project_center',
      rowNumber,
      record.externalId,
      existing ? 'UPDATE' : 'CREATE',
      row.id,
      existing?.comparable ?? null,
      desired,
    );
  }

  private async insertRun(
    trx: Transaction<Database>,
    actor: AuthenticatedSession,
    idempotencyKey: string,
    mode: 'PREVIEW' | 'APPLY',
    status: LegacyImportStatus,
    sourceName: string,
    sourceSha256: string,
    payloadHash: string,
    summary: LegacyMasterImportRun['summary'],
    context: RequestContext,
  ) {
    return trx
      .insertInto('legacy_master_import_run')
      .values({
        actor_user_id: actor.user.id,
        idempotency_key: idempotencyKey,
        mode,
        status,
        source_name: sourceName,
        source_sha256: sourceSha256,
        payload_hash: payloadHash,
        summary: toJsonb(summary),
        request_id: context.requestId,
        ip: context.ip,
        user_agent: context.userAgent,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async insertItems(
    trx: Transaction<Database>,
    runId: string,
    items: readonly InternalItem[],
  ): Promise<void> {
    if (items.length === 0) return;
    await trx
      .insertInto('legacy_master_import_item')
      .values(
        items.map((importItem) => ({
          run_id: runId,
          entity: importItem.entity,
          row_number: importItem.rowNumber,
          external_id: importItem.externalId,
          operation: importItem.operation,
          target_id: importItem.targetId,
          issues: toJsonb(importItem.issues),
          changes_before: importItem.before === null ? null : toJsonb(importItem.before),
          changes_after: importItem.after === null ? null : toJsonb(importItem.after),
        })),
      )
      .execute();
  }

  private async auditRun(
    trx: Transaction<Database>,
    actor: AuthenticatedSession,
    status: LegacyImportStatus,
    runId: string,
    context: RequestContext,
    summary: LegacyMasterImportRun['summary'],
  ): Promise<void> {
    const action =
      status === 'APPLIED'
        ? 'LEGACY_MASTER_IMPORT_APPLIED'
        : status === 'REJECTED'
          ? 'LEGACY_MASTER_IMPORT_REJECTED'
          : 'LEGACY_MASTER_IMPORT_PREVIEWED';
    await trx
      .insertInto('audit_event')
      .values({
        app_user_id: actor.user.id,
        actor_roles: actor.user.roles,
        action,
        entity: 'legacy_master_import_run',
        entity_id: runId,
        result: 'success',
        request_id: context.requestId,
        ip: context.ip,
        user_agent: context.userAgent,
        reason: null,
        changes_before: null,
        changes_after: toJsonb(summary),
        metadata: null,
      })
      .execute();
  }
}
