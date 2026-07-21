import { Decimal } from 'decimal.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  Client,
  ClientDetail,
  CoordinatorProfile,
  CreateClient,
  CreateCoordinator,
  CreateIssuerCompany,
  CreateProduct,
  CreateProjectCenter,
  CreateReceiver,
  InvoiceRule,
  IssuerCompany,
  MasterListQuery,
  Product,
  ProjectCenter,
  PutInvoiceRule,
  Receiver,
  UpdateClient,
  UpdateCoordinator,
  UpdateIssuerCompany,
  UpdateProduct,
  UpdateProjectCenter,
  UpdateReceiver,
} from '@factuflow/shared-schemas';
import type { MasterService, Page } from '../../application/billing/master-service.js';
import type {
  AuthenticatedSession,
  RequestContext,
} from '../../application/auth/identity-service.js';
import { AppError } from '../../application/errors.js';
import {
  formatChileanRut,
  InvalidChileanRutError,
  normalizeChileanRut,
} from '../../domain/billing/chilean-rut.js';
import { normalizeProductName } from '../../domain/billing/product-name.js';
import type { Database, JsonValue } from './schema.js';

type Executor = Kysely<Database> | Transaction<Database>;

function iso(value: Date): string {
  return value.toISOString();
}

function nullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isPgCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function translateDatabaseError(error: unknown): never {
  if (isPgCode(error, '23505')) {
    throw new AppError('MASTER_DUPLICATE', 'Ya existe un registro con esos datos.', 409);
  }
  if (isPgCode(error, '23503') || isPgCode(error, '23514')) {
    throw new AppError('MASTER_INVALID_RELATION', 'Los datos o relaciones no son válidos.', 422);
  }
  throw error;
}

function normalizeRut(value: string): string {
  try {
    return normalizeChileanRut(value);
  } catch (error) {
    if (error instanceof InvalidChileanRutError) {
      throw new AppError('INVALID_RUT', error.message, 422);
    }
    throw error;
  }
}

function page<T>(items: T[], query: MasterListQuery, total: number): Page<T> {
  return { items, page: query.page, pageSize: query.pageSize, total };
}

function offset(query: MasterListQuery): number {
  return (query.page - 1) * query.pageSize;
}

function activeFilter(active: MasterListQuery['active']): boolean | undefined {
  return active === 'all' ? undefined : active === 'true';
}

function safe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class PostgresMasterService implements MasterService {
  constructor(private readonly db: Kysely<Database>) {}

  async listIssuerCompanies(query: MasterListQuery): Promise<Page<IssuerCompany>> {
    let rowsQuery = this.db.selectFrom('issuer_company').selectAll();
    let countQuery = this.db
      .selectFrom('issuer_company')
      .select(sql<number>`count(*)::integer`.as('total'));
    if (query.q) {
      const term = `%${query.q}%`;
      rowsQuery = rowsQuery.where((eb) =>
        eb.or([
          eb('code', 'ilike', term),
          eb('legal_name', 'ilike', term),
          eb('tax_id', 'ilike', term),
        ]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([
          eb('code', 'ilike', term),
          eb('legal_name', 'ilike', term),
          eb('tax_id', 'ilike', term),
        ]),
      );
    }
    const active = activeFilter(query.active);
    if (active !== undefined) {
      rowsQuery = rowsQuery.where('is_active', '=', active);
      countQuery = countQuery.where('is_active', '=', active);
    }
    const orderColumn = query.sort === 'createdAt' ? 'created_at' : 'legal_name';
    const [rows, count] = await Promise.all([
      rowsQuery
        .orderBy(orderColumn, query.order)
        .limit(query.pageSize)
        .offset(offset(query))
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return page(
      rows.map((row) => this.mapIssuer(row)),
      query,
      count.total,
    );
  }

  async getIssuerCompany(id: string): Promise<IssuerCompany> {
    return this.mapIssuer(await this.requireIssuer(this.db, id));
  }

  async createIssuerCompany(
    actor: AuthenticatedSession,
    input: CreateIssuerCompany,
    context: RequestContext,
  ): Promise<IssuerCompany> {
    this.assertRate(input.defaultIvaRate);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('issuer_company')
          .values({
            code: input.code.trim(),
            legal_name: input.legalName.trim(),
            tax_id: normalizeRut(input.taxId),
            business_activity: input.businessActivity.trim(),
            address: input.address.trim(),
            default_tax_treatment: input.defaultTaxTreatment,
            default_iva_rate: input.defaultIvaRate,
            is_active: true,
            created_by: actor.user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapIssuer(row);
        await this.audit(
          trx,
          actor,
          'ISSUER_COMPANY_CREATED',
          'issuer_company',
          row.id,
          context,
          null,
          result,
        );
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async updateIssuerCompany(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateIssuerCompany,
    context: RequestContext,
  ): Promise<IssuerCompany> {
    if (input.defaultIvaRate !== undefined) this.assertRate(input.defaultIvaRate);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = this.mapIssuer(await this.requireIssuer(trx, id, true));
        const patch = {
          ...(input.code === undefined ? {} : { code: input.code.trim() }),
          ...(input.legalName === undefined ? {} : { legal_name: input.legalName.trim() }),
          ...(input.taxId === undefined ? {} : { tax_id: normalizeRut(input.taxId) }),
          ...(input.businessActivity === undefined
            ? {}
            : { business_activity: input.businessActivity.trim() }),
          ...(input.address === undefined ? {} : { address: input.address.trim() }),
          ...(input.defaultTaxTreatment === undefined
            ? {}
            : { default_tax_treatment: input.defaultTaxTreatment }),
          ...(input.defaultIvaRate === undefined ? {} : { default_iva_rate: input.defaultIvaRate }),
        };
        const result = this.mapIssuer(
          await trx
            .updateTable('issuer_company')
            .set(patch)
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
        await this.audit(
          trx,
          actor,
          'ISSUER_COMPANY_UPDATED',
          'issuer_company',
          id,
          context,
          before,
          result,
        );
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async setIssuerCompanyActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<IssuerCompany> {
    return this.db.transaction().execute(async (trx) => {
      const before = this.mapIssuer(await this.requireIssuer(trx, id, true));
      const row = await trx
        .updateTable('issuer_company')
        .set({ is_active: active })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const result = this.mapIssuer(row);
      await this.audit(
        trx,
        actor,
        active ? 'ISSUER_COMPANY_ACTIVATED' : 'ISSUER_COMPANY_DEACTIVATED',
        'issuer_company',
        id,
        context,
        before,
        result,
      );
      return result;
    });
  }

  async listCoordinators(query: MasterListQuery): Promise<Page<CoordinatorProfile>> {
    let rowsQuery = this.db.selectFrom('coordinator_profile').selectAll();
    let countQuery = this.db
      .selectFrom('coordinator_profile')
      .select(sql<number>`count(*)::integer`.as('total'));
    if (query.q) {
      const term = `%${query.q}%`;
      rowsQuery = rowsQuery.where((eb) =>
        eb.or([eb('display_name', 'ilike', term), eb('email', 'ilike', term)]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([eb('display_name', 'ilike', term), eb('email', 'ilike', term)]),
      );
    }
    const active = activeFilter(query.active);
    if (active !== undefined) {
      rowsQuery = rowsQuery.where('is_active', '=', active);
      countQuery = countQuery.where('is_active', '=', active);
    }
    const orderColumn = query.sort === 'createdAt' ? 'created_at' : 'display_name';
    const [rows, count] = await Promise.all([
      rowsQuery
        .orderBy(orderColumn, query.order)
        .limit(query.pageSize)
        .offset(offset(query))
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return page(
      rows.map((row) => this.mapCoordinator(row)),
      query,
      count.total,
    );
  }

  async getCoordinator(id: string): Promise<CoordinatorProfile> {
    return this.mapCoordinator(await this.requireCoordinator(this.db, id));
  }

  async createCoordinator(
    actor: AuthenticatedSession,
    input: CreateCoordinator,
    context: RequestContext,
  ): Promise<CoordinatorProfile> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        if (input.appUserId) await this.requireUser(trx, input.appUserId);
        const row = await trx
          .insertInto('coordinator_profile')
          .values({
            display_name: input.displayName.trim(),
            email: nullable(input.email)?.toLowerCase() ?? null,
            app_user_id: input.appUserId,
            is_active: true,
            created_by: actor.user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapCoordinator(row);
        await this.audit(
          trx,
          actor,
          'COORDINATOR_CREATED',
          'coordinator_profile',
          row.id,
          context,
          null,
          result,
        );
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async updateCoordinator(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateCoordinator,
    context: RequestContext,
  ): Promise<CoordinatorProfile> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = this.mapCoordinator(await this.requireCoordinator(trx, id, true));
        if (input.appUserId) await this.requireUser(trx, input.appUserId);
        const result = this.mapCoordinator(
          await trx
            .updateTable('coordinator_profile')
            .set({
              ...(input.displayName === undefined
                ? {}
                : { display_name: input.displayName.trim() }),
              ...(input.email === undefined
                ? {}
                : { email: nullable(input.email)?.toLowerCase() ?? null }),
              ...(input.appUserId === undefined ? {} : { app_user_id: input.appUserId }),
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
        await this.audit(
          trx,
          actor,
          'COORDINATOR_UPDATED',
          'coordinator_profile',
          id,
          context,
          before,
          result,
        );
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async setCoordinatorActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<CoordinatorProfile> {
    return this.db.transaction().execute(async (trx) => {
      const before = this.mapCoordinator(await this.requireCoordinator(trx, id, true));
      const row = await trx
        .updateTable('coordinator_profile')
        .set({ is_active: active })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const result = this.mapCoordinator(row);
      await this.audit(
        trx,
        actor,
        active ? 'COORDINATOR_ACTIVATED' : 'COORDINATOR_DEACTIVATED',
        'coordinator_profile',
        id,
        context,
        before,
        result,
      );
      return result;
    });
  }

  async linkCoordinatorUser(
    actor: AuthenticatedSession,
    id: string,
    appUserId: string | null,
    context: RequestContext,
  ): Promise<CoordinatorProfile> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = this.mapCoordinator(await this.requireCoordinator(trx, id, true));
        if (appUserId) await this.requireUser(trx, appUserId);
        const result = this.mapCoordinator(
          await trx
            .updateTable('coordinator_profile')
            .set({ app_user_id: appUserId })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
        await this.audit(
          trx,
          actor,
          appUserId ? 'COORDINATOR_USER_LINKED' : 'COORDINATOR_USER_UNLINKED',
          'coordinator_profile',
          id,
          context,
          before,
          result,
        );
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async listClients(query: MasterListQuery): Promise<Page<Client>> {
    let rowsQuery = this.db
      .selectFrom('client')
      .leftJoin(
        'coordinator_profile',
        'coordinator_profile.id',
        'client.default_coordinator_profile_id',
      )
      .selectAll('client')
      .select('coordinator_profile.display_name as coordinator_name');
    let countQuery = this.db
      .selectFrom('client')
      .select(sql<number>`count(*)::integer`.as('total'));
    if (query.q) {
      const term = `%${query.q}%`;
      const normalizedSearch = query.q.replace(/[.\-\s]/g, '').toUpperCase();
      rowsQuery = rowsQuery.where((eb) =>
        eb.or([
          eb('client.short_name', 'ilike', term),
          eb('client.legal_name', 'ilike', term),
          eb('client.tax_id', 'ilike', `%${normalizedSearch}%`),
        ]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([
          eb('short_name', 'ilike', term),
          eb('legal_name', 'ilike', term),
          eb('tax_id', 'ilike', `%${normalizedSearch}%`),
        ]),
      );
    }
    const active = activeFilter(query.active);
    if (active !== undefined) {
      rowsQuery = rowsQuery.where('client.is_active', '=', active);
      countQuery = countQuery.where('is_active', '=', active);
    }
    const orderColumn = query.sort === 'createdAt' ? 'client.created_at' : 'client.short_name';
    const [rows, count] = await Promise.all([
      rowsQuery
        .orderBy(orderColumn, query.order)
        .limit(query.pageSize)
        .offset(offset(query))
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return page(
      rows.map((row) => this.mapClient(row, row.coordinator_name)),
      query,
      count.total,
    );
  }

  async getClient(id: string): Promise<ClientDetail> {
    return this.getClientFrom(this.db, id);
  }

  async createClient(
    actor: AuthenticatedSession,
    input: CreateClient,
    context: RequestContext,
  ): Promise<ClientDetail> {
    this.assertClient(input);
    try {
      return await this.db.transaction().execute(async (trx) => {
        if (input.defaultCoordinatorProfileId)
          await this.requireActiveCoordinator(trx, input.defaultCoordinatorProfileId);
        const row = await trx
          .insertInto('client')
          .values({
            short_name: input.shortName.trim(),
            legal_name: nullable(input.legalName),
            tax_id: input.taxId ? normalizeRut(input.taxId) : null,
            business_activity: nullable(input.businessActivity),
            address: nullable(input.address),
            default_coordinator_profile_id: input.defaultCoordinatorProfileId,
            data_status: input.dataStatus,
            is_active: true,
            created_by: actor.user.id,
            updated_by: actor.user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const result = await this.getClientFrom(trx, row.id);
        await this.audit(trx, actor, 'CLIENT_CREATED', 'client', row.id, context, null, result);
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async updateClient(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateClient,
    context: RequestContext,
  ): Promise<ClientDetail> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = await this.getClientFrom(trx, id, true);
        const merged = {
          dataStatus: input.dataStatus ?? before.dataStatus,
          taxId: input.taxId === undefined ? before.taxId : input.taxId,
          legalName: input.legalName === undefined ? before.legalName : input.legalName,
          businessActivity:
            input.businessActivity === undefined ? before.businessActivity : input.businessActivity,
          address: input.address === undefined ? before.address : input.address,
        };
        this.assertClient(merged);
        if (input.defaultCoordinatorProfileId)
          await this.requireActiveCoordinator(trx, input.defaultCoordinatorProfileId);
        await trx
          .updateTable('client')
          .set({
            ...(input.shortName === undefined ? {} : { short_name: input.shortName.trim() }),
            ...(input.legalName === undefined ? {} : { legal_name: nullable(input.legalName) }),
            ...(input.taxId === undefined
              ? {}
              : { tax_id: input.taxId ? normalizeRut(input.taxId) : null }),
            ...(input.businessActivity === undefined
              ? {}
              : { business_activity: nullable(input.businessActivity) }),
            ...(input.address === undefined ? {} : { address: nullable(input.address) }),
            ...(input.defaultCoordinatorProfileId === undefined
              ? {}
              : { default_coordinator_profile_id: input.defaultCoordinatorProfileId }),
            ...(input.dataStatus === undefined ? {} : { data_status: input.dataStatus }),
            updated_by: actor.user.id,
          })
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        const result = await this.getClientFrom(trx, id);
        await this.audit(trx, actor, 'CLIENT_UPDATED', 'client', id, context, before, result);
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async setClientActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<ClientDetail> {
    return this.db.transaction().execute(async (trx) => {
      const before = await this.getClientFrom(trx, id, true);
      await trx
        .updateTable('client')
        .set({ is_active: active, updated_by: actor.user.id })
        .where('id', '=', id)
        .execute();
      const result = await this.getClientFrom(trx, id);
      await this.audit(
        trx,
        actor,
        active ? 'CLIENT_ACTIVATED' : 'CLIENT_DEACTIVATED',
        'client',
        id,
        context,
        before,
        result,
      );
      return result;
    });
  }

  async putInvoiceRule(
    actor: AuthenticatedSession,
    clientId: string,
    input: PutInvoiceRule,
    context: RequestContext,
  ): Promise<InvoiceRule> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.requireClientRow(trx, clientId, true);
        if (input.defaultIssuerCompanyId)
          await this.requireIssuer(trx, input.defaultIssuerCompanyId);
        const existing = await trx
          .selectFrom('client_invoice_rule')
          .selectAll()
          .where('client_id', '=', clientId)
          .executeTakeFirst();
        const values = {
          purchase_order_requirement: input.purchaseOrderRequirement,
          hes_requirement: input.hesRequirement,
          contract_requirement: input.contractRequirement,
          supplier_number: nullable(input.supplierNumber),
          default_issuer_company_id: input.defaultIssuerCompanyId,
          default_tax_treatment: input.defaultTaxTreatment,
          excel_template_variant: input.excelTemplateVariant,
          billing_notes: nullable(input.billingNotes),
          is_active: input.isActive,
          updated_by: actor.user.id,
        };
        const row = existing
          ? await trx
              .updateTable('client_invoice_rule')
              .set(values)
              .where('client_id', '=', clientId)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('client_invoice_rule')
              .values({ ...values, client_id: clientId, created_by: actor.user.id })
              .returningAll()
              .executeTakeFirstOrThrow();
        const result = this.mapInvoiceRule(row);
        await this.audit(
          trx,
          actor,
          'CLIENT_INVOICE_RULE_CHANGED',
          'client',
          clientId,
          context,
          existing ? this.mapInvoiceRule(existing) : null,
          result,
        );
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async listReceivers(clientId: string, query: MasterListQuery): Promise<Page<Receiver>> {
    await this.requireClientRow(this.db, clientId);
    let rowsQuery = this.db.selectFrom('receiver').selectAll().where('client_id', '=', clientId);
    let countQuery = this.db
      .selectFrom('receiver')
      .select(sql<number>`count(*)::integer`.as('total'))
      .where('client_id', '=', clientId);
    if (query.q) {
      const term = `%${query.q}%`;
      rowsQuery = rowsQuery.where((eb) =>
        eb.or([eb('email', 'ilike', term), eb('display_name', 'ilike', term)]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([eb('email', 'ilike', term), eb('display_name', 'ilike', term)]),
      );
    }
    const active = activeFilter(query.active);
    if (active !== undefined) {
      rowsQuery = rowsQuery.where('is_active', '=', active);
      countQuery = countQuery.where('is_active', '=', active);
    }
    const [rows, count] = await Promise.all([
      rowsQuery
        .orderBy(query.sort === 'createdAt' ? 'created_at' : 'email', query.order)
        .limit(query.pageSize)
        .offset(offset(query))
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return page(
      rows.map((row) => this.mapReceiver(row)),
      query,
      count.total,
    );
  }

  async createReceiver(
    actor: AuthenticatedSession,
    clientId: string,
    input: CreateReceiver,
    context: RequestContext,
  ): Promise<Receiver> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.requireClientRow(trx, clientId, true);
        const row = await trx
          .insertInto('receiver')
          .values({
            client_id: clientId,
            display_name: nullable(input.displayName),
            email: input.email.trim().toLowerCase(),
            is_active: true,
            created_by: actor.user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapReceiver(row);
        await this.audit(trx, actor, 'RECEIVER_CREATED', 'receiver', row.id, context, null, result);
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async updateReceiver(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateReceiver,
    context: RequestContext,
  ): Promise<Receiver> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = this.mapReceiver(await this.requireReceiver(trx, id, true));
        const row = await trx
          .updateTable('receiver')
          .set({
            ...(input.displayName === undefined
              ? {}
              : { display_name: nullable(input.displayName) }),
            ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapReceiver(row);
        await this.audit(trx, actor, 'RECEIVER_UPDATED', 'receiver', id, context, before, result);
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async setReceiverActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<Receiver> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = this.mapReceiver(await this.requireReceiver(trx, id, true));
        const row = await trx
          .updateTable('receiver')
          .set({ is_active: active })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapReceiver(row);
        await this.audit(
          trx,
          actor,
          active ? 'RECEIVER_ACTIVATED' : 'RECEIVER_DEACTIVATED',
          'receiver',
          id,
          context,
          before,
          result,
        );
        return result;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return translateDatabaseError(error);
    }
  }

  async listProducts(query: MasterListQuery): Promise<Page<Product>> {
    let rowsQuery = this.db.selectFrom('product').selectAll();
    let countQuery = this.db
      .selectFrom('product')
      .select(sql<number>`count(*)::integer`.as('total'));
    if (query.q) {
      const term = `%${query.q}%`;
      rowsQuery = rowsQuery.where((eb) =>
        eb.or([eb('name', 'ilike', term), eb('code', 'ilike', term)]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([eb('name', 'ilike', term), eb('code', 'ilike', term)]),
      );
    }
    const active = activeFilter(query.active);
    if (active !== undefined) {
      rowsQuery = rowsQuery.where('is_active', '=', active);
      countQuery = countQuery.where('is_active', '=', active);
    }
    const [rows, count] = await Promise.all([
      rowsQuery
        .orderBy(query.sort === 'createdAt' ? 'created_at' : 'name', query.order)
        .limit(query.pageSize)
        .offset(offset(query))
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return page(
      rows.map((row) => this.mapProduct(row)),
      query,
      count.total,
    );
  }

  async getProduct(id: string): Promise<Product> {
    return this.mapProduct(await this.requireProduct(this.db, id));
  }

  async createProduct(
    actor: AuthenticatedSession,
    input: CreateProduct,
    context: RequestContext,
  ): Promise<Product> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('product')
          .values({
            code: nullable(input.code),
            name: input.name.trim(),
            normalized_name: normalizeProductName(input.name),
            is_active: true,
            created_by: actor.user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapProduct(row);
        await this.audit(trx, actor, 'PRODUCT_CREATED', 'product', row.id, context, null, result);
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async updateProduct(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateProduct,
    context: RequestContext,
  ): Promise<Product> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = this.mapProduct(await this.requireProduct(trx, id, true));
        const row = await trx
          .updateTable('product')
          .set({
            ...(input.code === undefined ? {} : { code: nullable(input.code) }),
            ...(input.name === undefined
              ? {}
              : { name: input.name.trim(), normalized_name: normalizeProductName(input.name) }),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapProduct(row);
        await this.audit(trx, actor, 'PRODUCT_UPDATED', 'product', id, context, before, result);
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async setProductActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<Product> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const before = this.mapProduct(await this.requireProduct(trx, id, true));
        const row = await trx
          .updateTable('product')
          .set({ is_active: active })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapProduct(row);
        await this.audit(
          trx,
          actor,
          active ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED',
          'product',
          id,
          context,
          before,
          result,
        );
        return result;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return translateDatabaseError(error);
    }
  }

  async listProjectCenters(clientId: string, query: MasterListQuery): Promise<Page<ProjectCenter>> {
    await this.requireClientRow(this.db, clientId);
    let rowsQuery = this.db
      .selectFrom('project_center')
      .innerJoin('product', 'product.id', 'project_center.product_id')
      .selectAll('project_center')
      .select('product.name as product_name')
      .where('project_center.client_id', '=', clientId);
    let countQuery = this.db
      .selectFrom('project_center')
      .select(sql<number>`count(*)::integer`.as('total'))
      .where('client_id', '=', clientId);
    if (query.q) {
      const term = `%${query.q}%`;
      rowsQuery = rowsQuery.where((eb) =>
        eb.or([
          eb('project_center.code', 'ilike', term),
          eb('project_center.project_name', 'ilike', term),
          eb('product.name', 'ilike', term),
        ]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([eb('code', 'ilike', term), eb('project_name', 'ilike', term)]),
      );
    }
    const active = activeFilter(query.active);
    if (active !== undefined) {
      rowsQuery = rowsQuery.where('project_center.is_active', '=', active);
      countQuery = countQuery.where('is_active', '=', active);
    }
    const [rows, count] = await Promise.all([
      rowsQuery
        .orderBy(
          query.sort === 'createdAt' ? 'project_center.created_at' : 'project_center.code',
          query.order,
        )
        .limit(query.pageSize)
        .offset(offset(query))
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return page(
      rows.map((row) => this.mapProjectCenter(row, row.product_name)),
      query,
      count.total,
    );
  }

  async getProjectCenter(id: string): Promise<ProjectCenter> {
    const row = await this.db
      .selectFrom('project_center')
      .innerJoin('product', 'product.id', 'project_center.product_id')
      .selectAll('project_center')
      .select('product.name as product_name')
      .where('project_center.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('PROJECT_CENTER_NOT_FOUND', 'El CP/MS no existe.', 404);
    return this.mapProjectCenter(row, row.product_name);
  }

  async createProjectCenter(
    actor: AuthenticatedSession,
    clientId: string,
    input: CreateProjectCenter,
    context: RequestContext,
  ): Promise<ProjectCenter> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const client = await this.requireClientRow(trx, clientId, true);
        if (!client.is_active)
          throw new AppError(
            'CLIENT_INACTIVE',
            'No se puede crear un CP/MS para un cliente inactivo.',
            422,
          );
        const product = await this.requireProduct(trx, input.productId, true);
        if (!product.is_active)
          throw new AppError('PRODUCT_INACTIVE', 'El producto debe estar activo.', 422);
        const row = await trx
          .insertInto('project_center')
          .values({
            client_id: clientId,
            product_id: input.productId,
            code: input.code.trim(),
            project_name: input.projectName.trim(),
            project_center_type: input.projectCenterType,
            is_active: true,
            created_by: actor.user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapProjectCenter(row, product.name);
        await this.audit(
          trx,
          actor,
          'PROJECT_CENTER_CREATED',
          'project_center',
          row.id,
          context,
          null,
          result,
        );
        return result;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return translateDatabaseError(error);
    }
  }

  async updateProjectCenter(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateProjectCenter,
    context: RequestContext,
  ): Promise<ProjectCenter> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const current = await this.requireProjectCenter(trx, id, true);
        const previousProduct = await this.requireProduct(trx, current.product_id);
        const product = input.productId
          ? await this.requireProduct(trx, input.productId)
          : previousProduct;
        if (input.productId && !product.is_active) {
          throw new AppError('PRODUCT_INACTIVE', 'El producto debe estar activo.', 422);
        }
        const before = this.mapProjectCenter(current, previousProduct.name);
        const row = await trx
          .updateTable('project_center')
          .set({
            ...(input.productId === undefined ? {} : { product_id: input.productId }),
            ...(input.code === undefined ? {} : { code: input.code.trim() }),
            ...(input.projectName === undefined ? {} : { project_name: input.projectName.trim() }),
            ...(input.projectCenterType === undefined
              ? {}
              : { project_center_type: input.projectCenterType }),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = this.mapProjectCenter(row, product.name);
        await this.audit(
          trx,
          actor,
          'PROJECT_CENTER_UPDATED',
          'project_center',
          id,
          context,
          before,
          result,
        );
        return result;
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async setProjectCenterActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<ProjectCenter> {
    return this.db.transaction().execute(async (trx) => {
      const beforeRow = await this.requireProjectCenter(trx, id, true);
      const product = await this.requireProduct(trx, beforeRow.product_id);
      const before = this.mapProjectCenter(beforeRow, product.name);
      const row = await trx
        .updateTable('project_center')
        .set({ is_active: active })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const result = this.mapProjectCenter(row, product.name);
      await this.audit(
        trx,
        actor,
        active ? 'PROJECT_CENTER_ACTIVATED' : 'PROJECT_CENTER_DEACTIVATED',
        'project_center',
        id,
        context,
        before,
        result,
      );
      return result;
    });
  }

  private assertRate(rate: string): void {
    let parsed: Decimal;
    try {
      parsed = new Decimal(rate);
    } catch {
      throw new AppError('INVALID_IVA_RATE', 'La tasa IVA no es válida.', 422);
    }
    if (parsed.isNegative() || parsed.greaterThan(1))
      throw new AppError('INVALID_IVA_RATE', 'La tasa IVA debe estar entre 0 y 1.', 422);
  }

  private assertClient(input: {
    dataStatus: string;
    taxId?: string | null;
    legalName?: string | null;
    businessActivity?: string | null;
    address?: string | null;
  }): void {
    if (input.taxId) normalizeRut(input.taxId);
    if (
      input.dataStatus === 'COMPLETE' &&
      (!input.taxId ||
        !nullable(input.legalName) ||
        !nullable(input.businessActivity) ||
        !nullable(input.address))
    ) {
      throw new AppError(
        'CLIENT_INCOMPLETE',
        'Un cliente completo requiere todos sus datos legales.',
        422,
      );
    }
  }

  private async getClientFrom(executor: Executor, id: string, lock = false): Promise<ClientDetail> {
    let query = executor
      .selectFrom('client')
      .leftJoin(
        'coordinator_profile',
        'coordinator_profile.id',
        'client.default_coordinator_profile_id',
      )
      .selectAll('client')
      .select('coordinator_profile.display_name as coordinator_name')
      .where('client.id', '=', id);
    if (lock) query = query.forUpdate('client');
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError('CLIENT_NOT_FOUND', 'El cliente no existe.', 404);
    const invoice = await executor
      .selectFrom('client_invoice_rule')
      .selectAll()
      .where('client_id', '=', id)
      .executeTakeFirst();
    return {
      ...this.mapClient(row, row.coordinator_name),
      invoiceRule: invoice ? this.mapInvoiceRule(invoice) : null,
    };
  }

  private async audit(
    executor: Executor,
    actor: AuthenticatedSession,
    action: string,
    entity: string,
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
        entity,
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

  private mapIssuer(
    row: Database['issuer_company'] extends never
      ? never
      : {
          id: string;
          code: string;
          legal_name: string;
          tax_id: string;
          business_activity: string;
          address: string;
          is_active: boolean;
          default_tax_treatment: 'AFFECTED' | 'EXEMPT';
          default_iva_rate: string;
          created_at: Date;
          updated_at: Date;
        },
  ): IssuerCompany {
    return {
      id: row.id,
      code: row.code,
      legalName: row.legal_name,
      taxId: formatChileanRut(row.tax_id),
      businessActivity: row.business_activity,
      address: row.address,
      isActive: row.is_active,
      defaultTaxTreatment: row.default_tax_treatment,
      defaultIvaRate: row.default_iva_rate,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private mapCoordinator(row: {
    id: string;
    app_user_id: string | null;
    display_name: string;
    email: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }): CoordinatorProfile {
    return {
      id: row.id,
      appUserId: row.app_user_id,
      displayName: row.display_name,
      email: row.email,
      isActive: row.is_active,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private mapClient(
    row: {
      id: string;
      short_name: string;
      legal_name: string | null;
      tax_id: string | null;
      business_activity: string | null;
      address: string | null;
      default_coordinator_profile_id: string | null;
      data_status: 'COMPLETE' | 'PENDING_COMPLETION';
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    },
    coordinatorName: string | null,
  ): Client {
    return {
      id: row.id,
      shortName: row.short_name,
      legalName: row.legal_name,
      taxId: row.tax_id ? formatChileanRut(row.tax_id) : null,
      businessActivity: row.business_activity,
      address: row.address,
      defaultCoordinatorProfileId: row.default_coordinator_profile_id,
      defaultCoordinatorDisplayName: coordinatorName,
      dataStatus: row.data_status,
      isActive: row.is_active,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private mapInvoiceRule(row: {
    client_id: string;
    purchase_order_requirement: 'REQUIRED' | 'OPTIONAL' | 'NOT_APPLICABLE';
    hes_requirement: 'REQUIRED' | 'OPTIONAL' | 'NOT_APPLICABLE';
    contract_requirement: 'REQUIRED' | 'OPTIONAL' | 'NOT_APPLICABLE';
    supplier_number: string | null;
    default_issuer_company_id: string | null;
    default_tax_treatment: 'AFFECTED' | 'EXEMPT' | null;
    excel_template_variant: 'STANDARD' | 'HABITAT';
    billing_notes: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }): InvoiceRule {
    return {
      clientId: row.client_id,
      purchaseOrderRequirement: row.purchase_order_requirement,
      hesRequirement: row.hes_requirement,
      contractRequirement: row.contract_requirement,
      supplierNumber: row.supplier_number,
      defaultIssuerCompanyId: row.default_issuer_company_id,
      defaultTaxTreatment: row.default_tax_treatment,
      excelTemplateVariant: row.excel_template_variant,
      billingNotes: row.billing_notes,
      isActive: row.is_active,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private mapReceiver(row: {
    id: string;
    client_id: string;
    display_name: string | null;
    email: string;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }): Receiver {
    return {
      id: row.id,
      clientId: row.client_id,
      displayName: row.display_name,
      email: row.email,
      isActive: row.is_active,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private mapProduct(row: {
    id: string;
    code: string | null;
    name: string;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }): Product {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.is_active,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private mapProjectCenter(
    row: {
      id: string;
      client_id: string;
      product_id: string;
      code: string;
      project_name: string;
      project_center_type: 'ADMINISTRATION_OPERATION' | 'DEVELOPMENT_HOURS' | 'CONSTRUCTION';
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    },
    productName: string,
  ): ProjectCenter {
    return {
      id: row.id,
      clientId: row.client_id,
      productId: row.product_id,
      productName,
      code: row.code,
      projectName: row.project_name,
      projectCenterType: row.project_center_type,
      isActive: row.is_active,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private async requireIssuer(executor: Executor, id: string, lock = false) {
    let query = executor.selectFrom('issuer_company').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError('ISSUER_COMPANY_NOT_FOUND', 'La empresa emisora no existe.', 404);
    return row;
  }
  private async requireCoordinator(executor: Executor, id: string, lock = false) {
    let query = executor.selectFrom('coordinator_profile').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError('COORDINATOR_NOT_FOUND', 'El responsable no existe.', 404);
    return row;
  }
  private async requireActiveCoordinator(executor: Executor, id: string) {
    const row = await this.requireCoordinator(executor, id);
    if (!row.is_active)
      throw new AppError('COORDINATOR_INACTIVE', 'El responsable sugerido debe estar activo.', 422);
    return row;
  }
  private async requireClientRow(executor: Executor, id: string, lock = false) {
    let query = executor.selectFrom('client').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError('CLIENT_NOT_FOUND', 'El cliente no existe.', 404);
    return row;
  }
  private async requireReceiver(executor: Executor, id: string, lock = false) {
    let query = executor.selectFrom('receiver').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError('RECEIVER_NOT_FOUND', 'El receptor no existe.', 404);
    return row;
  }
  private async requireProduct(executor: Executor, id: string, lock = false) {
    let query = executor.selectFrom('product').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError('PRODUCT_NOT_FOUND', 'El producto no existe.', 404);
    return row;
  }
  private async requireProjectCenter(executor: Executor, id: string, lock = false) {
    let query = executor.selectFrom('project_center').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError('PROJECT_CENTER_NOT_FOUND', 'El CP/MS no existe.', 404);
    return row;
  }
  private async requireUser(executor: Executor, id: string) {
    const row = await executor
      .selectFrom('app_user')
      .select(['id', 'is_active'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('USER_NOT_FOUND', 'El usuario no existe.', 404);
    return row;
  }
}
