import type { Kysely, Transaction } from 'kysely';
import type {
  InvoicePreviewRequest,
  InvoicePreviewResponse,
  UfValue,
} from '@factuflow/shared-schemas';
import type {
  AuthenticatedSession,
  RequestContext,
} from '../../application/auth/identity-service.js';
import { AppError } from '../../application/errors.js';
import type { InvoicePreviewService, UfService } from '../../application/uf/uf-service.js';
import type { UfProvider, UfProviderName } from '../../application/uf/uf-provider.js';
import { UfProviderError } from '../../application/uf/uf-provider.js';
import { calculateInvoiceAmounts } from '../../domain/calculation/invoice-calculation.js';
import { decimalToString, parseDecimalString } from '../../domain/calculation/decimal.js';
import { assertValidUfDate, InvalidUfDateError } from '../../domain/uf/uf-date.js';
import type { Database, JsonValue, UfSource } from './schema.js';

type Executor = Kysely<Database> | Transaction<Database>;

interface FetchedUf {
  value: string;
  source: UfProviderName;
  sourceReference: string;
}

function safe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function canonical(value: string): string {
  return decimalToString(parseDecimalString(value, 'ufValue', { positive: true }));
}

function validateDate(date: string): void {
  try {
    assertValidUfDate(date);
  } catch (error) {
    if (error instanceof InvalidUfDateError) {
      throw new AppError('UF_DATE_INVALID', error.message, 400);
    }
    throw error;
  }
}

export class PostgresUfService implements UfService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly providers: readonly UfProvider[],
    private readonly cacheEnabled: boolean,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  async get(date: string, actor: AuthenticatedSession, context: RequestContext): Promise<UfValue> {
    validateDate(date);
    if (this.cacheEnabled) {
      const cached = await this.db
        .selectFrom('uf_value')
        .selectAll()
        .where('value_date', '=', date)
        .executeTakeFirst();
      if (cached) return this.map(cached, true);
    }
    if (date > this.today()) {
      throw new AppError(
        'UF_NOT_PUBLISHED',
        'El valor UF para la fecha solicitada no está publicado.',
        404,
      );
    }

    const fetched = await this.fetchFromProviders(date, actor, context);
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('uf_value')
        .selectAll()
        .where('value_date', '=', date)
        .forUpdate()
        .executeTakeFirst();
      if (existing) return this.map(existing, true);

      const inserted = await trx
        .insertInto('uf_value')
        .values({
          value_date: date,
          value: fetched.value,
          source: fetched.source,
          fetched_at: new Date(),
          source_reference: fetched.sourceReference,
          metadata: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(trx, actor, 'UF_VALUE_FETCHED', inserted.id, context, null, {
        date,
        value: canonical(inserted.value),
        source: inserted.source,
      });
      return this.map(inserted, false);
    });
  }

  async refresh(
    date: string,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<UfValue> {
    validateDate(date);
    if (date > this.today()) {
      throw new AppError(
        'UF_NOT_PUBLISHED',
        'El valor UF para la fecha solicitada no está publicado.',
        404,
      );
    }
    const fetched = await this.fetchFromProviders(date, actor, context);

    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('uf_value')
        .selectAll()
        .where('value_date', '=', date)
        .forUpdate()
        .executeTakeFirst();
      const before = existing
        ? { date, value: canonical(existing.value), source: existing.source }
        : null;

      const row = existing
        ? await trx
            .updateTable('uf_value')
            .set({
              value: fetched.value,
              source: fetched.source,
              fetched_at: new Date(),
              source_reference: fetched.sourceReference,
              metadata: null,
            })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await trx
            .insertInto('uf_value')
            .values({
              value_date: date,
              value: fetched.value,
              source: fetched.source,
              fetched_at: new Date(),
              source_reference: fetched.sourceReference,
              metadata: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

      const after = { date, value: canonical(row.value), source: row.source };
      if (existing && canonical(existing.value) !== canonical(row.value)) {
        await this.audit(trx, actor, 'UF_VALUE_CHANGED', row.id, context, before, after);
      }
      await this.audit(trx, actor, 'UF_VALUE_REFRESHED', row.id, context, before, after);
      if (!existing) {
        await this.audit(trx, actor, 'UF_VALUE_FETCHED', row.id, context, null, after);
      }
      return this.map(row, false);
    });
  }

  private async fetchFromProviders(
    date: string,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<FetchedUf> {
    let sawInvalid = false;
    let sawTemporary = false;
    for (const provider of this.providers) {
      try {
        const result = await provider.fetch(date);
        if (result.status === 'found') {
          return {
            value: canonical(result.value),
            source: provider.name,
            sourceReference: result.sourceReference,
          };
        }
      } catch (error) {
        const kind = error instanceof UfProviderError ? error.kind : 'temporary';
        sawInvalid ||= kind === 'invalid-response';
        sawTemporary ||= kind === 'temporary';
        await this.auditFailure(actor, provider.name, date, kind, context);
      }
    }

    if (sawInvalid) {
      throw new AppError(
        'UF_PROVIDER_INVALID_RESPONSE',
        'Los proveedores UF entregaron una respuesta inválida.',
        502,
      );
    }
    if (sawTemporary) {
      throw new AppError(
        'UF_PROVIDER_UNAVAILABLE',
        'Los proveedores UF no están disponibles temporalmente.',
        503,
      );
    }
    throw new AppError(
      'UF_NOT_PUBLISHED',
      'El valor UF para la fecha solicitada no está publicado.',
      404,
    );
  }

  private async auditFailure(
    actor: AuthenticatedSession,
    provider: UfProviderName,
    date: string,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    await this.db
      .insertInto('audit_event')
      .values({
        app_user_id: actor.user.id,
        actor_roles: actor.user.roles,
        action: 'UF_PROVIDER_FAILED',
        entity: 'uf_value',
        entity_id: null,
        result: 'failure',
        request_id: context.requestId,
        ip: context.ip,
        user_agent: context.userAgent,
        reason,
        changes_before: null,
        changes_after: null,
        metadata: safe({ provider, date }),
      })
      .execute();
  }

  private async audit(
    executor: Executor,
    actor: AuthenticatedSession,
    action: string,
    entityId: string,
    context: RequestContext,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await executor
      .insertInto('audit_event')
      .values({
        app_user_id: actor.user.id,
        actor_roles: actor.user.roles,
        action,
        entity: 'uf_value',
        entity_id: entityId,
        result: 'success',
        request_id: context.requestId,
        ip: context.ip,
        user_agent: context.userAgent,
        reason: null,
        changes_before: before === null ? null : safe(before),
        changes_after: after === null ? null : safe(after),
        metadata: null,
      })
      .execute();
  }

  private map(
    row: {
      id: string;
      value_date: string | Date;
      value: string;
      source: UfSource;
      fetched_at: Date;
      source_reference: string | null;
    },
    fromCache: boolean,
  ): UfValue {
    return {
      id: row.id,
      date:
        row.value_date instanceof Date ? row.value_date.toISOString().slice(0, 10) : row.value_date,
      value: canonical(row.value),
      source: row.source,
      fetchedAt: row.fetched_at.toISOString(),
      sourceReference: row.source_reference,
      fromCache,
    };
  }
}

export class PostgresInvoicePreviewService implements InvoicePreviewService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly uf: UfService,
  ) {}

  async preview(
    input: InvoicePreviewRequest,
    actor: AuthenticatedSession,
    context: RequestContext,
  ): Promise<InvoicePreviewResponse> {
    validateDate(input.ufDate);
    const ids = input.lines.map((line) => line.projectCenterId);
    const rows = await this.db
      .selectFrom('project_center as pc')
      .innerJoin('client as c', 'c.id', 'pc.client_id')
      .select([
        'pc.id',
        'pc.client_id',
        'pc.code',
        'pc.project_name',
        'pc.is_active',
        'c.is_active as client_active',
      ])
      .where('pc.id', 'in', ids)
      .execute();

    if (rows.length !== ids.length) {
      throw new AppError('PROJECT_CENTER_NOT_FOUND', 'Uno o más CP/MS no existen.', 404);
    }
    if (rows.some((row) => !row.is_active || !row.client_active)) {
      throw new AppError(
        'PROJECT_CENTER_INACTIVE',
        'Todos los CP/MS y su cliente deben estar activos.',
        422,
      );
    }
    const clients = new Set(rows.map((row) => row.client_id));
    if (clients.size !== 1) {
      throw new AppError(
        'PROJECT_CENTER_CLIENT_MISMATCH',
        'Todos los CP/MS deben pertenecer al mismo cliente.',
        422,
      );
    }

    const fetched = input.ufValue ? null : await this.uf.get(input.ufDate, actor, context);
    let calculated;
    try {
      calculated = calculateInvoiceAmounts({
        ufDate: input.ufDate,
        ufValue: input.ufValue ?? fetched?.value ?? '',
        taxTreatment: input.taxTreatment,
        ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
        lines: input.lines,
      });
    } catch (error) {
      throw new AppError(
        'CALCULATION_INVALID',
        error instanceof Error ? error.message : 'Los datos de cálculo no son válidos.',
        422,
      );
    }

    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return {
      ...calculated,
      ufSource: fetched?.source ?? null,
      ufFromCache: fetched?.fromCache ?? null,
      clientId: rows[0]?.client_id ?? '',
      lines: calculated.lines.map((line) => {
        const row = rowsById.get(line.projectCenterId);
        if (!row) throw new Error('CP/MS validado dejó de estar disponible');
        return {
          ...line,
          projectCenterCode: row.code,
          projectName: row.project_name,
        };
      }),
    };
  }
}
