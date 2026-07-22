import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  INVOICE_CALCULATION_VERSION,
  type INVOICE_XLSX_MIME,
  type DocumentRequirement,
  type InvoiceRequestDetail,
  type InvoiceRequestDuplicateSource,
  type InvoiceRequestExportInput,
  type InvoiceRequestListItem,
  type InvoiceRequestListQuery,
} from '@factuflow/shared-schemas';
import type {
  InvoiceExportResult,
  InvoiceRequestService,
  InvoiceRequestsPage,
  InvoiceWorkbookData,
  InvoiceWorkbookRenderer,
} from '../../application/invoice-requests/invoice-request-service.js';
import type {
  AuthenticatedSession,
  RequestContext,
} from '../../application/auth/identity-service.js';
import type { UfService } from '../../application/uf/uf-service.js';
import { AppError } from '../../application/errors.js';
import { calculateInvoiceAmounts } from '../../domain/calculation/invoice-calculation.js';
import { decimalToString, parseDecimalString } from '../../domain/calculation/decimal.js';
import { formatFolio } from '../../domain/folio/folio.js';
import { safeFilenamePart, stableJson } from '../../domain/invoice-request/export-safety.js';
import { reserveFolio } from './db.js';
import type {
  Database,
  ExcelTemplateVariant,
  JsonValue,
  ProjectCenterType,
  TaxTreatment,
} from './schema.js';

type Executor = Kysely<Database> | Transaction<Database>;

interface ClientReference {
  id: string;
  shortName: string;
  legalName: string;
  taxId: string;
  businessActivity: string;
  address: string;
  updatedAt: Date;
}

interface IssuerReference {
  id: string;
  code: string;
  legalName: string;
  taxId: string;
  businessActivity: string;
  address: string;
  updatedAt: Date;
}

interface CoordinatorReference {
  id: string;
  displayName: string;
  email: string | null;
  updatedAt: Date;
}

interface RuleReference {
  purchaseOrderRequirement: DocumentRequirement;
  hesRequirement: DocumentRequirement;
  contractRequirement: DocumentRequirement;
  supplierNumber: string | null;
  defaultIssuerCompanyId: string | null;
  defaultTaxTreatment: TaxTreatment | null;
  excelTemplateVariant: ExcelTemplateVariant;
  billingNotes: string | null;
  updatedAt: Date;
}

interface CenterReference {
  id: string;
  code: string;
  projectName: string;
  projectCenterType: ProjectCenterType;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  centerUpdatedAt: Date;
  productUpdatedAt: Date | null;
}

interface ReceiverReference {
  id: string;
  updatedAt: Date;
}

interface PreparedReferences {
  client: ClientReference;
  issuer: IssuerReference;
  coordinator: CoordinatorReference;
  rule: RuleReference;
  centers: Map<string, CenterReference>;
  receivers: Map<string, ReceiverReference>;
  fingerprint: string;
}

interface PreparedExport {
  input: InvoiceRequestExportInput;
  payloadHash: string;
  references: PreparedReferences;
  purchaseOrderNumber: string | null;
  contractNumber: string | null;
  hesNumber: string | null;
  supplierNumber: string | null;
  calculation: ReturnType<typeof calculateInvoiceAmounts>;
  workbook: Awaited<ReturnType<InvoiceWorkbookRenderer['generateAndValidate']>>;
  sha256: string;
  requestId: string;
  exportId: string;
  filename: string;
}

interface StoredExportRow {
  id: string;
  folio: string;
  payload_hash: string;
  filename: string;
  mime_type: typeof INVOICE_XLSX_MIME;
  sha256: string;
  content: Buffer;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function canonicalDecimal(value: string, field: string, positive = false): string {
  return decimalToString(parseDecimalString(value, field, { positive }));
}

function ensureClpStorageRange(calculation: ReturnType<typeof calculateInvoiceAmounts>): void {
  const values = [
    calculation.netClp,
    calculation.ivaClp,
    calculation.totalClp,
    ...calculation.lines.map((line) => line.clpAmount),
  ];
  if (values.some((value) => !/^\d{1,30}$/.test(value))) {
    throw new AppError(
      'AMOUNT_OUT_OF_RANGE',
      'El resultado excede el rango monetario permitido para una solicitud.',
      422,
    );
  }
}

function iso(value: Date): string {
  return value.toISOString();
}

function enforceDocumentRule(
  field: string,
  requirement: DocumentRequirement,
  submitted: string | null,
): string | null {
  if (requirement === 'NOT_APPLICABLE') return null;
  if (requirement === 'REQUIRED' && !submitted) {
    throw new AppError(
      'DOCUMENT_REQUIREMENT_NOT_MET',
      `La configuración del cliente exige ${field}.`,
      422,
    );
  }
  return submitted;
}

function snapshots(refs: PreparedReferences): {
  client: JsonValue;
  issuer: JsonValue;
  coordinator: JsonValue;
  rule: JsonValue;
} {
  return {
    client: json({
      schemaVersion: 1,
      id: refs.client.id,
      shortName: refs.client.shortName,
      legalName: refs.client.legalName,
      taxId: refs.client.taxId,
      businessActivity: refs.client.businessActivity,
      address: refs.client.address,
    }),
    issuer: json({
      schemaVersion: 1,
      id: refs.issuer.id,
      code: refs.issuer.code,
      legalName: refs.issuer.legalName,
      taxId: refs.issuer.taxId,
      businessActivity: refs.issuer.businessActivity,
      address: refs.issuer.address,
    }),
    coordinator: json({
      schemaVersion: 1,
      id: refs.coordinator.id,
      displayName: refs.coordinator.displayName,
      email: refs.coordinator.email,
    }),
    rule: json({
      schemaVersion: 1,
      purchaseOrderRequirement: refs.rule.purchaseOrderRequirement,
      hesRequirement: refs.rule.hesRequirement,
      contractRequirement: refs.rule.contractRequirement,
      supplierNumber: refs.rule.supplierNumber,
      defaultIssuerCompanyId: refs.rule.defaultIssuerCompanyId,
      defaultTaxTreatment: refs.rule.defaultTaxTreatment,
      excelTemplateVariant: refs.rule.excelTemplateVariant,
      billingNotes: refs.rule.billingNotes,
    }),
  };
}

function snapshotText(snapshot: JsonValue, key: string): string {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return '';
  const value = snapshot[key];
  return typeof value === 'string' ? value : '';
}

function snapshotForApi<T>(snapshot: JsonValue): T {
  return snapshot as T;
}

export class PostgresInvoiceRequestService implements InvoiceRequestService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly uf: UfService,
    private readonly workbookRenderer: InvoiceWorkbookRenderer,
  ) {}

  async exportAndPersist(
    input: InvoiceRequestExportInput,
    idempotencyKey: string,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<InvoiceExportResult> {
    const payloadHash = createHash('sha256').update(stableJson(input)).digest('hex');
    const previous = await this.findStoredExport(this.db, actor.user.id, idempotencyKey);
    if (previous) return this.idempotentResult(previous, payloadHash);

    const prepared = await this.prepare(input, payloadHash, actor, context);

    return this.db.transaction().execute(async (trx) => {
      const lockKey = `${actor.user.id}:${idempotencyKey}`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);

      const concurrent = await this.findStoredExport(trx, actor.user.id, idempotencyKey);
      if (concurrent) return this.idempotentResult(concurrent, payloadHash);

      const lockedReferences = await this.loadReferences(trx, input, true);
      if (lockedReferences.fingerprint !== prepared.references.fingerprint) {
        throw new AppError(
          'MASTER_DATA_CHANGED',
          'Los maestros cambiaron mientras se preparaba la exportación. Revise y reintente.',
          409,
        );
      }

      const ufRow = await trx
        .selectFrom('uf_value')
        .select(['value', 'source'])
        .where('value_date', '=', input.ufDate)
        .forShare()
        .executeTakeFirst();
      if (!ufRow) {
        throw new AppError('UF_NOT_PUBLISHED', 'La UF seleccionada ya no está disponible.', 409);
      }
      if (canonicalDecimal(ufRow.value, 'ufValue', true) !== prepared.calculation.ufValue) {
        throw new AppError(
          'UF_VALUE_CHANGED',
          'El valor UF cambió. Confirme el nuevo valor antes de exportar.',
          409,
        );
      }

      const folioYear = Number.parseInt(input.requestDate.slice(0, 4), 10);
      const correlative = await reserveFolio(trx, folioYear);
      const folio = formatFolio({ year: folioYear, correlative });
      const now = new Date();
      const frozen = snapshots(prepared.references);

      await trx
        .insertInto('invoice_request')
        .values({
          id: prepared.requestId,
          folio,
          status: 'EXPORTED',
          source_request_id: input.sourceRequestId,
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          client_id: input.clientId,
          issuer_company_id: input.issuerCompanyId,
          coordinator_profile_id: input.coordinatorProfileId,
          period: input.period,
          request_date: input.requestDate,
          billing_date: input.billingDate,
          uf_date: input.ufDate,
          uf_value: prepared.calculation.ufValue,
          uf_source: ufRow.source,
          tax_treatment: prepared.calculation.taxTreatment,
          iva_rate: prepared.calculation.taxRate,
          net_clp: prepared.calculation.netClp,
          iva_clp: prepared.calculation.ivaClp,
          total_clp: prepared.calculation.totalClp,
          area: 'Plataformas',
          purchase_order_number: prepared.purchaseOrderNumber,
          contract_number: prepared.contractNumber,
          hes_number: prepared.hesNumber,
          supplier_number: prepared.supplierNumber,
          description: input.description,
          observations: input.observations,
          calculation_algorithm_version: INVOICE_CALCULATION_VERSION,
          excel_template_variant: prepared.references.rule.excelTemplateVariant,
          excel_template_version: prepared.workbook.templateVersion,
          client_snapshot: frozen.client,
          issuer_company_snapshot: frozen.issuer,
          coordinator_snapshot: frozen.coordinator,
          invoice_rule_snapshot: frozen.rule,
          exported_at: now,
          created_by: actor.user.id,
          created_at: now,
        })
        .execute();

      const calculatedByCenter = new Map(
        prepared.calculation.lines.map((line) => [line.projectCenterId, line]),
      );
      await trx
        .insertInto('invoice_request_line')
        .values(
          input.lines.map((line) => {
            const center = prepared.references.centers.get(line.projectCenterId);
            const calculated = calculatedByCenter.get(line.projectCenterId);
            if (!center || !calculated) throw new Error('Línea validada dejó de estar disponible.');
            return {
              invoice_request_id: prepared.requestId,
              position: line.position,
              project_center_id: center.id,
              project_center_code: center.code,
              project_name: center.projectName,
              project_center_type: center.projectCenterType,
              product_id: center.productId,
              product_code: center.productCode,
              product_name: center.productName,
              uf_amount: canonicalDecimal(calculated.ufAmount, 'ufAmount', true),
              uf_value: prepared.calculation.ufValue,
              clp_amount: calculated.clpAmount,
              created_at: now,
            };
          }),
        )
        .execute();

      await trx
        .insertInto('invoice_request_receiver')
        .values(
          input.receivers.map((receiver) => ({
            invoice_request_id: prepared.requestId,
            position: receiver.position,
            receiver_id: receiver.receiverId,
            display_name: receiver.displayName,
            email: receiver.email,
            created_at: now,
          })),
        )
        .execute();

      const bytes = Buffer.from(prepared.workbook.bytes);
      await trx
        .insertInto('invoice_export')
        .values({
          id: prepared.exportId,
          invoice_request_id: prepared.requestId,
          content: bytes,
          filename: prepared.filename,
          mime_type: prepared.workbook.mimeType,
          size_bytes: String(bytes.byteLength),
          sha256: prepared.sha256,
          template_variant: prepared.references.rule.excelTemplateVariant,
          template_version: prepared.workbook.templateVersion,
          created_at: now,
        })
        .execute();

      await this.audit(trx, actor, 'INVOICE_REQUEST_EXPORTED', prepared.requestId, context, {
        invoiceRequestId: prepared.requestId,
        folio,
        clientId: input.clientId,
        coordinatorProfileId: input.coordinatorProfileId,
        taxTreatment: prepared.calculation.taxTreatment,
        netClp: prepared.calculation.netClp,
        ivaClp: prepared.calculation.ivaClp,
        totalClp: prepared.calculation.totalClp,
        templateVariant: prepared.references.rule.excelTemplateVariant,
        templateVersion: prepared.workbook.templateVersion,
        calculationVersion: prepared.calculation.algorithmVersion,
        exportSha256: prepared.sha256,
        sourceRequestId: input.sourceRequestId,
      });

      return {
        invoiceRequestId: prepared.requestId,
        folio,
        filename: prepared.filename,
        mimeType: prepared.workbook.mimeType,
        sha256: prepared.sha256,
        bytes: prepared.workbook.bytes,
      };
    });
  }

  async list(query: InvoiceRequestListQuery): Promise<InvoiceRequestsPage> {
    let rowsQuery = this.db.selectFrom('invoice_request').selectAll();
    let countQuery = this.db
      .selectFrom('invoice_request')
      .select(sql<number>`count(invoice_request.id)::integer`.as('total'));

    if (query.clientId) {
      rowsQuery = rowsQuery.where('client_id', '=', query.clientId);
      countQuery = countQuery.where('client_id', '=', query.clientId);
    }
    if (query.coordinatorProfileId) {
      rowsQuery = rowsQuery.where('coordinator_profile_id', '=', query.coordinatorProfileId);
      countQuery = countQuery.where('coordinator_profile_id', '=', query.coordinatorProfileId);
    }
    if (query.period) {
      rowsQuery = rowsQuery.where('period', '=', query.period);
      countQuery = countQuery.where('period', '=', query.period);
    }
    if (query.from) {
      rowsQuery = rowsQuery.where('request_date', '>=', query.from);
      countQuery = countQuery.where('request_date', '>=', query.from);
    }
    if (query.to) {
      rowsQuery = rowsQuery.where('request_date', '<=', query.to);
      countQuery = countQuery.where('request_date', '<=', query.to);
    }
    if (query.billingFrom) {
      rowsQuery = rowsQuery.where('billing_date', '>=', query.billingFrom);
      countQuery = countQuery.where('billing_date', '>=', query.billingFrom);
    }
    if (query.billingTo) {
      rowsQuery = rowsQuery.where('billing_date', '<=', query.billingTo);
      countQuery = countQuery.where('billing_date', '<=', query.billingTo);
    }
    if (query.taxTreatment) {
      rowsQuery = rowsQuery.where('tax_treatment', '=', query.taxTreatment);
      countQuery = countQuery.where('tax_treatment', '=', query.taxTreatment);
    }
    if (query.status) {
      rowsQuery = rowsQuery.where('status', '=', query.status);
      countQuery = countQuery.where('status', '=', query.status);
    }
    if (query.q) {
      const pattern = `%${query.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      const filter = sql<boolean>`(
        folio ILIKE ${pattern} ESCAPE '\\'
        OR client_snapshot ->> 'shortName' ILIKE ${pattern} ESCAPE '\\'
        OR client_snapshot ->> 'legalName' ILIKE ${pattern} ESCAPE '\\'
        OR coordinator_snapshot ->> 'displayName' ILIKE ${pattern} ESCAPE '\\'
      )`;
      rowsQuery = rowsQuery.where(filter);
      countQuery = countQuery.where(filter);
    }

    const [rows, count] = await Promise.all([
      rowsQuery
        .orderBy('exported_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((row) => this.mapListItem(row)),
      page: query.page,
      pageSize: query.pageSize,
      total: count.total,
    };
  }

  async get(id: string): Promise<InvoiceRequestDetail> {
    const request = await this.db
      .selectFrom('invoice_request')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!request) throw new AppError('INVOICE_REQUEST_NOT_FOUND', 'La solicitud no existe.', 404);

    const [lines, receivers, exported] = await Promise.all([
      this.db
        .selectFrom('invoice_request_line')
        .selectAll()
        .where('invoice_request_id', '=', id)
        .orderBy('position')
        .execute(),
      this.db
        .selectFrom('invoice_request_receiver')
        .selectAll()
        .where('invoice_request_id', '=', id)
        .orderBy('position')
        .execute(),
      this.db
        .selectFrom('invoice_export')
        .select([
          'id',
          'filename',
          'mime_type',
          'size_bytes',
          'sha256',
          'template_variant',
          'template_version',
          'created_at',
        ])
        .where('invoice_request_id', '=', id)
        .executeTakeFirst(),
    ]);
    if (!exported) throw new Error('Solicitud exportada sin archivo asociado.');

    return {
      ...this.mapListItem(request),
      ufDate: dateOnly(request.uf_date),
      ufValue: canonicalDecimal(request.uf_value, 'ufValue', true),
      ufSource: request.uf_source,
      ivaRate: canonicalDecimal(request.iva_rate, 'ivaRate'),
      area: request.area,
      purchaseOrderNumber: request.purchase_order_number,
      contractNumber: request.contract_number,
      hesNumber: request.hes_number,
      supplierNumber: request.supplier_number,
      description: request.description,
      observations: request.observations,
      calculationAlgorithmVersion: request.calculation_algorithm_version,
      excelTemplateVariant: request.excel_template_variant,
      excelTemplateVersion: request.excel_template_version,
      clientSnapshot: snapshotForApi<InvoiceRequestDetail['clientSnapshot']>(
        request.client_snapshot,
      ),
      issuerCompanySnapshot: snapshotForApi<InvoiceRequestDetail['issuerCompanySnapshot']>(
        request.issuer_company_snapshot,
      ),
      coordinatorSnapshot: snapshotForApi<InvoiceRequestDetail['coordinatorSnapshot']>(
        request.coordinator_snapshot,
      ),
      invoiceRuleSnapshot: snapshotForApi<InvoiceRequestDetail['invoiceRuleSnapshot']>(
        request.invoice_rule_snapshot,
      ),
      createdAt: request.created_at.toISOString(),
      lines: lines.map((line) => ({
        id: line.id,
        position: line.position,
        projectCenterId: line.project_center_id,
        projectCenterCode: line.project_center_code,
        projectName: line.project_name,
        projectCenterType: line.project_center_type,
        productId: line.product_id,
        productCode: line.product_code,
        productName: line.product_name,
        ufAmount: canonicalDecimal(line.uf_amount, 'ufAmount', true),
        ufValue: canonicalDecimal(line.uf_value, 'ufValue', true),
        clpAmount: canonicalDecimal(line.clp_amount, 'clpAmount'),
      })),
      receivers: receivers.map((receiver) => ({
        id: receiver.id,
        position: receiver.position,
        receiverId: receiver.receiver_id,
        displayName: receiver.display_name,
        email: receiver.email,
      })),
      export: {
        id: exported.id,
        filename: exported.filename,
        mimeType: exported.mime_type,
        sizeBytes: exported.size_bytes,
        sha256: exported.sha256,
        templateVariant: exported.template_variant,
        templateVersion: exported.template_version,
        createdAt: exported.created_at.toISOString(),
      },
    };
  }

  async duplicateSource(id: string): Promise<InvoiceRequestDuplicateSource> {
    const detail = await this.get(id);
    return {
      sourceRequestId: detail.id,
      clientId: detail.clientId,
      issuerCompanyId: detail.issuerCompanyId,
      coordinatorProfileId: detail.coordinatorProfileId,
      period: detail.period,
      requestDate: detail.requestDate,
      billingDate: detail.billingDate,
      ufDate: detail.ufDate,
      ufValue: detail.ufValue,
      taxTreatment: detail.taxTreatment,
      taxRate: detail.ivaRate,
      area: 'Plataformas',
      purchaseOrderNumber: detail.purchaseOrderNumber,
      contractNumber: detail.contractNumber,
      hesNumber: detail.hesNumber,
      supplierNumber: detail.supplierNumber,
      description: detail.description,
      observations: detail.observations,
      lines: detail.lines.map((line) => ({
        projectCenterId: line.projectCenterId,
        ufAmount: line.ufAmount,
        position: line.position,
      })),
      receivers: detail.receivers.map((receiver) => ({
        receiverId: receiver.receiverId,
        displayName: receiver.displayName,
        email: receiver.email,
        position: receiver.position,
      })),
    };
  }

  async download(
    id: string,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<InvoiceExportResult> {
    const row = await this.db
      .selectFrom('invoice_request as ir')
      .innerJoin('invoice_export as ie', 'ie.invoice_request_id', 'ir.id')
      .select(['ir.id', 'ir.folio', 'ie.filename', 'ie.mime_type', 'ie.sha256', 'ie.content'])
      .where('ir.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('INVOICE_REQUEST_NOT_FOUND', 'La solicitud no existe.', 404);

    await this.audit(this.db, actor, 'INVOICE_EXPORT_DOWNLOADED', row.id, context, {
      invoiceRequestId: row.id,
      folio: row.folio,
      exportSha256: row.sha256,
    });
    return {
      invoiceRequestId: row.id,
      folio: row.folio,
      filename: row.filename,
      mimeType: row.mime_type,
      sha256: row.sha256,
      bytes: row.content,
    };
  }

  private async prepare(
    input: InvoiceRequestExportInput,
    payloadHash: string,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<PreparedExport> {
    if (input.sourceRequestId) {
      const source = await this.db
        .selectFrom('invoice_request')
        .select('id')
        .where('id', '=', input.sourceRequestId)
        .executeTakeFirst();
      if (!source)
        throw new AppError('SOURCE_REQUEST_NOT_FOUND', 'La solicitud origen no existe.', 404);
    }

    const references = await this.loadReferences(this.db, input, false);
    const purchaseOrderNumber = enforceDocumentRule(
      'OC',
      references.rule.purchaseOrderRequirement,
      input.purchaseOrderNumber,
    );
    const hesNumber = enforceDocumentRule('HES', references.rule.hesRequirement, input.hesNumber);
    const contractNumber = enforceDocumentRule(
      'contrato',
      references.rule.contractRequirement,
      input.contractNumber,
    );
    const supplierNumber = input.supplierNumber ?? references.rule.supplierNumber;

    const currentUf = await this.uf.get(input.ufDate, actor, context);
    const submittedUf = canonicalDecimal(input.ufValue, 'ufValue', true);
    const authoritativeUf = canonicalDecimal(currentUf.value, 'ufValue', true);
    if (submittedUf !== authoritativeUf) {
      throw new AppError(
        'UF_VALUE_CHANGED',
        'El valor UF cambió. Confirme el nuevo valor antes de exportar.',
        409,
      );
    }

    let calculation: ReturnType<typeof calculateInvoiceAmounts>;
    try {
      calculation = calculateInvoiceAmounts({
        ufDate: input.ufDate,
        ufValue: authoritativeUf,
        taxTreatment: input.taxTreatment,
        ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
        lines: input.lines,
      });
    } catch (error) {
      throw new AppError(
        'CALCULATION_INVALID',
        error instanceof Error ? error.message : 'El cálculo no es válido.',
        422,
      );
    }
    ensureClpStorageRange(calculation);

    const calculatedByCenter = new Map(
      calculation.lines.map((line) => [line.projectCenterId, line]),
    );
    const workbookData: InvoiceWorkbookData = {
      templateVariant: references.rule.excelTemplateVariant,
      issuerLegalName: references.issuer.legalName,
      clientShortName: references.client.shortName,
      clientLegalName: references.client.legalName,
      clientTaxId: references.client.taxId,
      clientBusinessActivity: references.client.businessActivity,
      clientAddress: references.client.address,
      purchaseOrderNumber,
      contractNumber,
      hesNumber,
      supplierNumber,
      description: input.description,
      observations: input.observations,
      area: 'Plataformas',
      coordinatorDisplayName: references.coordinator.displayName,
      requestDate: input.requestDate,
      billingDate: input.billingDate,
      period: input.period,
      ufDate: input.ufDate,
      ufValue: calculation.ufValue,
      taxTreatment: calculation.taxTreatment,
      netClp: calculation.netClp,
      ivaClp: calculation.ivaClp,
      totalClp: calculation.totalClp,
      lines: input.lines.map((line) => {
        const center = references.centers.get(line.projectCenterId);
        const calculated = calculatedByCenter.get(line.projectCenterId);
        if (!center || !calculated) throw new Error('Línea validada dejó de estar disponible.');
        return {
          position: line.position,
          projectCenterCode: center.code,
          projectName: center.projectName,
          productName: center.productName,
          ufAmount: calculated.ufAmount,
          clpAmount: calculated.clpAmount,
        };
      }),
      receivers: input.receivers,
    };

    const workbook = await this.workbookRenderer.generateAndValidate(workbookData);
    const bytes = Buffer.from(workbook.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const requestId = randomUUID();
    const exportId = randomUUID();
    const filename = `Solicitud_factura_${safeFilenamePart(references.client.shortName)}_${input.period}_${exportId.slice(0, 8)}.xlsx`;

    return {
      input,
      payloadHash,
      references,
      purchaseOrderNumber,
      contractNumber,
      hesNumber,
      supplierNumber,
      calculation,
      workbook,
      sha256,
      requestId,
      exportId,
      filename,
    };
  }

  private async loadReferences(
    executor: Executor,
    input: InvoiceRequestExportInput,
    lock: boolean,
  ): Promise<PreparedReferences> {
    let clientQuery = executor.selectFrom('client').selectAll().where('id', '=', input.clientId);
    let ruleQuery = executor
      .selectFrom('client_invoice_rule')
      .selectAll()
      .where('client_id', '=', input.clientId);
    let issuerQuery = executor
      .selectFrom('issuer_company')
      .selectAll()
      .where('id', '=', input.issuerCompanyId);
    let coordinatorQuery = executor
      .selectFrom('coordinator_profile')
      .selectAll()
      .where('id', '=', input.coordinatorProfileId);
    if (lock) {
      clientQuery = clientQuery.forShare();
      ruleQuery = ruleQuery.forShare();
      issuerQuery = issuerQuery.forShare();
      coordinatorQuery = coordinatorQuery.forShare();
    }
    const [client, rule, issuer, coordinator] = await Promise.all([
      clientQuery.executeTakeFirst(),
      ruleQuery.executeTakeFirst(),
      issuerQuery.executeTakeFirst(),
      coordinatorQuery.executeTakeFirst(),
    ]);

    if (!client) throw new AppError('CLIENT_NOT_FOUND', 'El cliente no existe.', 404);
    if (!client.is_active) throw new AppError('CLIENT_INACTIVE', 'El cliente está inactivo.', 422);
    if (client.data_status !== 'COMPLETE') {
      throw new AppError(
        'CLIENT_INCOMPLETE',
        'El cliente no tiene sus datos legales completos.',
        422,
      );
    }
    if (!client.legal_name || !client.tax_id || !client.business_activity || !client.address) {
      throw new AppError(
        'CLIENT_INCOMPLETE',
        'El cliente no tiene sus datos legales completos.',
        422,
      );
    }
    if (!rule || !rule.is_active) {
      throw new AppError(
        'INVOICE_RULE_UNAVAILABLE',
        'El cliente no tiene una configuración de facturación activa.',
        422,
      );
    }
    if (!issuer) throw new AppError('ISSUER_COMPANY_NOT_FOUND', 'La emisora no existe.', 404);
    if (!issuer.is_active)
      throw new AppError('ISSUER_COMPANY_INACTIVE', 'La emisora está inactiva.', 422);
    if (!coordinator) throw new AppError('COORDINATOR_NOT_FOUND', 'El responsable no existe.', 404);
    if (!coordinator.is_active) {
      throw new AppError('COORDINATOR_INACTIVE', 'El responsable está inactivo.', 422);
    }

    const centerIds = input.lines.map((line) => line.projectCenterId);
    let centersQuery = executor
      .selectFrom('project_center as pc')
      .select([
        'pc.id',
        'pc.client_id',
        'pc.code',
        'pc.project_name',
        'pc.project_center_type',
        'pc.product_id',
        'pc.is_active',
        'pc.updated_at as center_updated_at',
      ])
      .where('pc.id', 'in', centerIds);
    if (lock) centersQuery = centersQuery.forShare();
    const centerRows = await centersQuery.execute();
    if (centerRows.length !== centerIds.length) {
      throw new AppError('PROJECT_CENTER_NOT_FOUND', 'Uno o más CP/MS no existen.', 404);
    }
    if (centerRows.some((center) => center.client_id !== client.id)) {
      throw new AppError(
        'PROJECT_CENTER_CLIENT_MISMATCH',
        'Todos los CP/MS deben pertenecer al cliente seleccionado.',
        422,
      );
    }

    const productIds = [
      ...new Set(
        centerRows
          .map((center) => center.product_id)
          .filter((productId): productId is string => productId !== null),
      ),
    ];
    let productRows: Array<{
      id: string;
      code: string | null;
      name: string;
      is_active: boolean;
      updated_at: Date;
    }> = [];
    if (productIds.length > 0) {
      let productQuery = executor
        .selectFrom('product')
        .select(['id', 'code', 'name', 'is_active', 'updated_at'])
        .where('id', 'in', productIds);
      if (lock) productQuery = productQuery.forShare();
      productRows = await productQuery.execute();
    }
    const productById = new Map(productRows.map((product) => [product.id, product]));

    if (
      centerRows.some((center) => {
        if (!center.is_active) return true;
        if (!center.product_id) return false;
        return productById.get(center.product_id)?.is_active !== true;
      })
    ) {
      throw new AppError(
        'PROJECT_CENTER_INACTIVE',
        'Todos los CP/MS deben estar activos; si tienen producto asociado, también debe estar activo.',
        422,
      );
    }

    const receiverIds = input.receivers
      .map((receiver) => receiver.receiverId)
      .filter((receiverId): receiverId is string => receiverId !== null);
    const uniqueReceiverIds = [...new Set(receiverIds)];
    let receiverRows: Array<{
      id: string;
      client_id: string;
      is_active: boolean;
      updated_at: Date;
    }> = [];
    if (uniqueReceiverIds.length > 0) {
      let receiverQuery = executor
        .selectFrom('receiver')
        .select(['id', 'client_id', 'is_active', 'updated_at'])
        .where('id', 'in', uniqueReceiverIds);
      if (lock) receiverQuery = receiverQuery.forShare();
      receiverRows = await receiverQuery.execute();
      if (receiverRows.length !== uniqueReceiverIds.length) {
        throw new AppError('RECEIVER_NOT_FOUND', 'Uno o más receptores no existen.', 404);
      }
      if (receiverRows.some((receiver) => receiver.client_id !== client.id)) {
        throw new AppError(
          'RECEIVER_CLIENT_MISMATCH',
          'Los receptores deben pertenecer al cliente seleccionado.',
          422,
        );
      }
      if (receiverRows.some((receiver) => !receiver.is_active)) {
        throw new AppError('RECEIVER_INACTIVE', 'Uno o más receptores están inactivos.', 422);
      }
    }

    const centers = new Map<string, CenterReference>(
      centerRows.map((center) => [
        center.id,
        (() => {
          const product = center.product_id ? productById.get(center.product_id) : null;
          return {
            id: center.id,
            code: center.code,
            projectName: center.project_name,
            projectCenterType: center.project_center_type,
            productId: center.product_id,
            productCode: product?.code ?? null,
            productName: product?.name ?? null,
            centerUpdatedAt: center.center_updated_at,
            productUpdatedAt: product?.updated_at ?? null,
          };
        })(),
      ]),
    );
    const receivers = new Map<string, ReceiverReference>(
      receiverRows.map((receiver) => [
        receiver.id,
        { id: receiver.id, updatedAt: receiver.updated_at },
      ]),
    );
    const fingerprint = stableJson({
      client: [client.id, iso(client.updated_at)],
      rule: [rule.client_id, iso(rule.updated_at)],
      issuer: [issuer.id, iso(issuer.updated_at)],
      coordinator: [coordinator.id, iso(coordinator.updated_at)],
      centers: [...centers.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((center) => [
          center.id,
          iso(center.centerUpdatedAt),
          center.productUpdatedAt ? iso(center.productUpdatedAt) : null,
        ]),
      receivers: [...receivers.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((receiver) => [receiver.id, iso(receiver.updatedAt)]),
    });

    return {
      client: {
        id: client.id,
        shortName: client.short_name,
        legalName: client.legal_name,
        taxId: client.tax_id,
        businessActivity: client.business_activity,
        address: client.address,
        updatedAt: client.updated_at,
      },
      issuer: {
        id: issuer.id,
        code: issuer.code,
        legalName: issuer.legal_name,
        taxId: issuer.tax_id,
        businessActivity: issuer.business_activity,
        address: issuer.address,
        updatedAt: issuer.updated_at,
      },
      coordinator: {
        id: coordinator.id,
        displayName: coordinator.display_name,
        email: coordinator.email,
        updatedAt: coordinator.updated_at,
      },
      rule: {
        purchaseOrderRequirement: rule.purchase_order_requirement,
        hesRequirement: rule.hes_requirement,
        contractRequirement: rule.contract_requirement,
        supplierNumber: rule.supplier_number,
        defaultIssuerCompanyId: rule.default_issuer_company_id,
        defaultTaxTreatment: rule.default_tax_treatment,
        excelTemplateVariant: rule.excel_template_variant,
        billingNotes: rule.billing_notes,
        updatedAt: rule.updated_at,
      },
      centers,
      receivers,
      fingerprint,
    };
  }

  private async findStoredExport(
    executor: Executor,
    userId: string,
    idempotencyKey: string,
  ): Promise<StoredExportRow | undefined> {
    return executor
      .selectFrom('invoice_request as ir')
      .innerJoin('invoice_export as ie', 'ie.invoice_request_id', 'ir.id')
      .select([
        'ir.id',
        'ir.folio',
        'ir.payload_hash',
        'ie.filename',
        'ie.mime_type',
        'ie.sha256',
        'ie.content',
      ])
      .where('ir.created_by', '=', userId)
      .where('ir.idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  private idempotentResult(row: StoredExportRow, payloadHash: string): InvoiceExportResult {
    if (row.payload_hash !== payloadHash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'La clave de idempotencia ya se usó con otro contenido.',
        409,
      );
    }
    return {
      invoiceRequestId: row.id,
      folio: row.folio,
      filename: row.filename,
      mimeType: row.mime_type,
      sha256: row.sha256,
      bytes: row.content,
    };
  }

  private mapListItem(row: {
    id: string;
    folio: string;
    status: 'EXPORTED';
    source_request_id: string | null;
    client_id: string;
    issuer_company_id: string;
    coordinator_profile_id: string;
    period: string;
    request_date: string | Date;
    billing_date: string | Date;
    tax_treatment: TaxTreatment;
    net_clp: string;
    iva_clp: string;
    total_clp: string;
    client_snapshot: JsonValue;
    issuer_company_snapshot: JsonValue;
    coordinator_snapshot: JsonValue;
    exported_at: Date;
    created_by: string;
  }): InvoiceRequestListItem {
    return {
      id: row.id,
      folio: row.folio,
      status: row.status,
      statusLabel: 'Factura solicitada',
      clientId: row.client_id,
      clientShortName: snapshotText(row.client_snapshot, 'shortName'),
      issuerCompanyId: row.issuer_company_id,
      issuerCompanyLegalName: snapshotText(row.issuer_company_snapshot, 'legalName'),
      coordinatorProfileId: row.coordinator_profile_id,
      coordinatorDisplayName: snapshotText(row.coordinator_snapshot, 'displayName'),
      period: row.period,
      requestDate: dateOnly(row.request_date),
      billingDate: dateOnly(row.billing_date),
      taxTreatment: row.tax_treatment,
      netClp: canonicalDecimal(row.net_clp, 'netClp'),
      ivaClp: canonicalDecimal(row.iva_clp, 'ivaClp'),
      totalClp: canonicalDecimal(row.total_clp, 'totalClp'),
      exportedAt: row.exported_at.toISOString(),
      createdBy: row.created_by,
      sourceRequestId: row.source_request_id,
    };
  }

  private async audit(
    executor: Executor,
    actor: AuthenticatedSession,
    action: 'INVOICE_REQUEST_EXPORTED' | 'INVOICE_EXPORT_DOWNLOADED',
    entityId: string,
    context: RequestContext,
    metadata: unknown,
  ): Promise<void> {
    await executor
      .insertInto('audit_event')
      .values({
        app_user_id: actor.user.id,
        actor_roles: actor.user.roles,
        action,
        entity: 'invoice_request',
        entity_id: entityId,
        result: 'success',
        request_id: context.requestId,
        ip: context.ip,
        user_agent: context.userAgent,
        reason: null,
        changes_before: null,
        changes_after: null,
        metadata: json(metadata),
      })
      .execute();
  }
}
