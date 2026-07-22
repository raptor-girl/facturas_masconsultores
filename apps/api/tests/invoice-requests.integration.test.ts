import { createHash } from 'node:crypto';
import ExcelJS from '@excel.js/exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { connect, INSUFFICIENT_PRIVILEGE, isPgError, startTestDatabase } from './setup/postgres.js';
import type { TestDatabase } from './setup/postgres.js';
import { createDb } from '../src/infrastructure/postgres/db.js';
import type { Database } from '../src/infrastructure/postgres/schema.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { buildServer } from '../src/presentation/http/server.js';
import { PostgresIdentityService } from '../src/infrastructure/postgres/identity-service.js';
import type { InvoiceRequestExportInput } from '@factuflow/shared-schemas';
import {
  listFormulaCells,
  readExactNumericCell,
  readFormulaCell,
} from '../src/infrastructure/excel/xlsx-archive.js';

interface Jar {
  cookie: string;
  csrf: string;
}

describe('solicitudes exportadas, idempotencia, folios y XLSX', () => {
  let database: TestDatabase;
  let db: Kysely<Database>;
  let env: Env;
  let app: FastifyInstance;
  let admin: Jar;
  let coordinator: Jar;
  let noRole: Jar;
  let issuerId = '';
  let coordinatorProfileId = '';
  let standardClientId = '';
  let habitatClientId = '';
  let standardReceiverId = '';
  let habitatReceiverId = '';
  let centerOne = '';
  let centerTwo = '';
  let habitatCenter = '';

  const login = async (identifier: string, password: string): Promise<Jar> => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier, password },
    });
    expect(response.statusCode).toBe(200);
    const session = response.cookies.find((cookie) => cookie.name === env.SESSION_COOKIE_NAME)!;
    const csrf = response.cookies.find(
      (cookie) => cookie.name === `${env.SESSION_COOKIE_NAME}_csrf`,
    )!;
    return {
      cookie: `${session.name}=${session.value}; ${csrf.name}=${csrf.value}`,
      csrf: csrf.value,
    };
  };

  const request = (
    jar: Jar,
    options: {
      method: NonNullable<InjectOptions['method']>;
      url: string;
      payload?: NonNullable<InjectOptions['payload']>;
      idempotencyKey?: string;
      csrf?: boolean;
    },
  ) =>
    app.inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        cookie: jar.cookie,
        ...(options.csrf === false ? {} : { 'x-csrf-token': jar.csrf }),
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      },
    });

  const standardPayload = (): InvoiceRequestExportInput => ({
    sourceRequestId: null,
    clientId: standardClientId,
    issuerCompanyId: issuerId,
    coordinatorProfileId,
    period: '2026-07',
    requestDate: '2026-07-20',
    billingDate: '2026-07-25',
    ufDate: '2024-01-10',
    ufValue: '40543.07',
    taxTreatment: 'AFFECTED',
    area: 'Plataformas',
    purchaseOrderNumber: 'OC-TEST-100',
    contractNumber: 'SE-DEBE-LIMPIAR',
    hesNumber: null,
    supplierNumber: 'PROV-TEST-1',
    description: 'Servicios ficticios de julio',
    observations: 'Sólo datos ficticios',
    lines: [
      { projectCenterId: centerOne, ufAmount: '10.5', position: 1 },
      { projectCenterId: centerTwo, ufAmount: '20.3', position: 2 },
    ],
    receivers: [
      {
        receiverId: standardReceiverId,
        displayName: 'Receptor Ficticio',
        email: 'receiver.standard@example.invalid',
        position: 1,
      },
      {
        receiverId: null,
        displayName: 'Receptor Puntual',
        email: 'temporary.receiver@example.invalid',
        position: 2,
      },
    ],
  });

  const counts = async () => ({
    requests: Number(
      (
        await db
          .selectFrom('invoice_request')
          .select(sql<string>`count(id)`.as('total'))
          .executeTakeFirstOrThrow()
      ).total,
    ),
    lines: Number(
      (
        await db
          .selectFrom('invoice_request_line')
          .select(sql<string>`count(id)`.as('total'))
          .executeTakeFirstOrThrow()
      ).total,
    ),
    exports: Number(
      (
        await db
          .selectFrom('invoice_export')
          .select(sql<string>`count(id)`.as('total'))
          .executeTakeFirstOrThrow()
      ).total,
    ),
    folio:
      (
        await db
          .selectFrom('folio_counter')
          .select('last_value')
          .where('year', '=', 2026)
          .executeTakeFirst()
      )?.last_value ?? 0,
  });

  beforeAll(async () => {
    database = await startTestDatabase();
    env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL_APP: database.appUri,
      PASSWORD_HASH_MEMORY_KIB: '8192',
      PASSWORD_HASH_TIME_COST: '2',
      UF_REQUEST_RETRIES: '0',
    });
    db = createDb({ connectionString: env.DATABASE_URL_APP });
    app = await buildServer({ env, db, version: '0.5.0-test' });
    await app.ready();

    const identity = new PostgresIdentityService(db, env);
    const bootstrap = await identity.bootstrapAdmin({
      username: 'admin.phase5',
      email: 'admin.phase5@example.invalid',
      displayName: 'Admin fase cinco',
    });
    admin = await login('admin.phase5', bootstrap.temporaryPassword);
    expect(
      (
        await request(admin, {
          method: 'POST',
          url: '/auth/change-password',
          payload: {
            currentPassword: bootstrap.temporaryPassword,
            newPassword: 'Admin-Phase-Five-42!',
          },
        })
      ).statusCode,
    ).toBe(200);

    const unprivilegedCreated = await request(admin, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'unprivileged.phase5',
        email: 'unprivileged.phase5@example.invalid',
        displayName: 'Usuario sin rol fase cinco',
        roles: ['COORDINATOR'],
      },
    });
    const unprivilegedTemporary = unprivilegedCreated.json<{ temporaryPassword: string }>()
      .temporaryPassword;
    noRole = await login('unprivileged.phase5', unprivilegedTemporary);
    expect(
      (
        await request(noRole, {
          method: 'POST',
          url: '/auth/change-password',
          payload: {
            currentPassword: unprivilegedTemporary,
            newPassword: 'Unprivileged-Phase-Five-42!',
          },
        })
      ).statusCode,
    ).toBe(200);
    const unprivilegedUser = await db
      .selectFrom('app_user')
      .select('id')
      .where('username', '=', 'unprivileged.phase5')
      .executeTakeFirstOrThrow();
    await db.deleteFrom('app_user_role').where('app_user_id', '=', unprivilegedUser.id).execute();

    const created = await request(admin, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        username: 'coordinator.phase5',
        email: 'coordinator.phase5@example.invalid',
        displayName: 'Coordinador fase cinco',
        roles: ['COORDINATOR'],
      },
    });
    const temporary = created.json<{ temporaryPassword: string }>().temporaryPassword;
    coordinator = await login('coordinator.phase5', temporary);
    expect(
      (
        await request(coordinator, {
          method: 'POST',
          url: '/auth/change-password',
          payload: {
            currentPassword: temporary,
            newPassword: 'Coordinator-Phase-Five-42!',
          },
        })
      ).statusCode,
    ).toBe(200);

    const issuer = await db
      .insertInto('issuer_company')
      .values({
        code: 'ISS-P5',
        legal_name: 'Emisora Ficticia SpA',
        tax_id: '765432105',
        business_activity: 'Servicios ficticios',
        address: 'Calle Ficticia 100',
        default_tax_treatment: 'AFFECTED',
        default_iva_rate: '0.19',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    issuerId = issuer.id;
    const profile = await db
      .insertInto('coordinator_profile')
      .values({ display_name: 'Responsable Ficticio', email: 'responsible@example.invalid' })
      .returning('id')
      .executeTakeFirstOrThrow();
    coordinatorProfileId = profile.id;
    const clients = await db
      .insertInto('client')
      .values([
        {
          short_name: 'Cliente Standard Ficticio',
          legal_name: 'Cliente Standard Ficticio SpA',
          tax_id: '123456785',
          business_activity: 'Actividad ficticia',
          address: 'Avenida Ficticia 1',
          default_coordinator_profile_id: profile.id,
          data_status: 'COMPLETE',
        },
        {
          short_name: 'Cliente Variante Ficticia',
          legal_name: 'Cliente Variante Ficticia SpA',
          tax_id: '112223334',
          business_activity: 'Actividad ficticia',
          address: 'Avenida Ficticia 2',
          default_coordinator_profile_id: profile.id,
          data_status: 'COMPLETE',
        },
      ])
      .returning(['id', 'short_name'])
      .execute();
    standardClientId = clients.find((client) => client.short_name.includes('Standard'))?.id ?? '';
    habitatClientId = clients.find((client) => client.short_name.includes('Variante'))?.id ?? '';
    await db
      .insertInto('client_invoice_rule')
      .values([
        {
          client_id: standardClientId,
          purchase_order_requirement: 'REQUIRED',
          hes_requirement: 'OPTIONAL',
          contract_requirement: 'NOT_APPLICABLE',
          supplier_number: 'PROV-DEFAULT',
          default_issuer_company_id: issuer.id,
          default_tax_treatment: 'AFFECTED',
          excel_template_variant: 'STANDARD',
        },
        {
          client_id: habitatClientId,
          purchase_order_requirement: 'REQUIRED',
          hes_requirement: 'OPTIONAL',
          contract_requirement: 'REQUIRED',
          default_issuer_company_id: issuer.id,
          default_tax_treatment: 'EXEMPT',
          excel_template_variant: 'HABITAT',
        },
      ])
      .execute();
    const receiverRows = await db
      .insertInto('receiver')
      .values([
        {
          client_id: standardClientId,
          display_name: 'Receptor Ficticio',
          email: 'receiver.standard@example.invalid',
        },
        {
          client_id: habitatClientId,
          display_name: 'Receptor Variante',
          email: 'receiver.variant@example.invalid',
        },
      ])
      .returning(['id', 'client_id'])
      .execute();
    standardReceiverId =
      receiverRows.find((receiver) => receiver.client_id === standardClientId)?.id ?? '';
    habitatReceiverId =
      receiverRows.find((receiver) => receiver.client_id === habitatClientId)?.id ?? '';
    const product = await db
      .insertInto('product')
      .values({ code: 'P5', name: 'Producto Ficticio', normalized_name: 'producto ficticio' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const centers = await db
      .insertInto('project_center')
      .values([
        {
          client_id: standardClientId,
          product_id: product.id,
          code: 'CP-P5-1',
          project_name: 'Proyecto ficticio uno',
          project_center_type: 'DEVELOPMENT_HOURS',
        },
        {
          client_id: standardClientId,
          product_id: product.id,
          code: 'CP-P5-2',
          project_name: 'Proyecto ficticio dos',
          project_center_type: 'CONSTRUCTION',
        },
        {
          client_id: habitatClientId,
          product_id: product.id,
          code: 'CP-P5-H',
          project_name: 'Proyecto variante ficticio',
          project_center_type: 'ADMINISTRATION_OPERATION',
        },
      ])
      .returning(['id', 'code'])
      .execute();
    centerOne = centers.find((center) => center.code === 'CP-P5-1')?.id ?? '';
    centerTwo = centers.find((center) => center.code === 'CP-P5-2')?.id ?? '';
    habitatCenter = centers.find((center) => center.code === 'CP-P5-H')?.id ?? '';
    await db
      .insertInto('uf_value')
      .values({
        value_date: '2024-01-10',
        value: '40543.07',
        source: 'sii.cl',
        fetched_at: new Date('2024-01-10T12:00:00.000Z'),
        source_reference: 'https://www.sii.cl/valores_y_fechas/uf/uf2024.htm',
        metadata: null,
      })
      .execute();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await database.stop();
  });

  it('abrir/listar/duplicar/previsualizar no crea solicitud ni reserva folio', async () => {
    expect(await counts()).toEqual({ requests: 0, lines: 0, exports: 0, folio: 0 });
    expect((await app.inject({ method: 'GET', url: '/invoice-requests' })).statusCode).toBe(401);
    expect((await request(noRole, { method: 'GET', url: '/invoice-requests' })).statusCode).toBe(
      403,
    );
    expect(
      (
        await request(noRole, {
          method: 'POST',
          url: '/invoice-requests/export',
          payload: standardPayload(),
          idempotencyKey: 'phase5-no-role-0001',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await request(coordinator, { method: 'GET', url: '/invoice-requests' })).statusCode,
    ).toBe(200);
    const preview = await request(coordinator, {
      method: 'POST',
      url: '/calculations/invoice-preview',
      payload: {
        ufDate: '2024-01-10',
        ufValue: '40543.07',
        taxTreatment: 'AFFECTED',
        lines: [{ projectCenterId: centerOne, ufAmount: '1', position: 1 }],
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(await counts()).toEqual({ requests: 0, lines: 0, exports: 0, folio: 0 });
  });

  it('exige CSRF e Idempotency-Key y no reserva folio ante validación documental', async () => {
    const noCsrf = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: standardPayload(),
      idempotencyKey: 'phase5-no-csrf-0001',
      csrf: false,
    });
    expect(noCsrf.statusCode).toBe(403);
    const noKey = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: standardPayload(),
    });
    expect(noKey.statusCode).toBe(400);
    const invalid = standardPayload();
    invalid.purchaseOrderNumber = null;
    const missingDocument = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: invalid,
      idempotencyKey: 'phase5-missing-doc-01',
    });
    expect(missingDocument.statusCode).toBe(422);
    expect(missingDocument.json<{ error: { code: string } }>().error.code).toBe(
      'DOCUMENT_REQUIREMENT_NOT_MET',
    );
    const clientCannotSendFinals = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: { ...standardPayload(), netClp: '1', totalClp: '1' },
      idempotencyKey: 'phase5-client-finals-01',
    });
    expect(clientCannotSendFinals.statusCode).toBe(400);
    expect(await counts()).toEqual({ requests: 0, lines: 0, exports: 0, folio: 0 });
  });

  it('rechaza cliente incompleto y maestros inactivos antes de generar o reservar', async () => {
    const cases = [
      {
        table: 'client' as const,
        id: standardClientId,
        column: 'is_active' as const,
        value: false,
      },
      {
        table: 'client' as const,
        id: standardClientId,
        column: 'data_status' as const,
        value: 'PENDING_COMPLETION' as const,
      },
      {
        table: 'issuer_company' as const,
        id: issuerId,
        column: 'is_active' as const,
        value: false,
      },
      {
        table: 'coordinator_profile' as const,
        id: coordinatorProfileId,
        column: 'is_active' as const,
        value: false,
      },
      {
        table: 'project_center' as const,
        id: centerOne,
        column: 'is_active' as const,
        value: false,
      },
      {
        table: 'receiver' as const,
        id: standardReceiverId,
        column: 'is_active' as const,
        value: false,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const original = await db
        .selectFrom(testCase.table)
        .select(testCase.column)
        .where('id', '=', testCase.id)
        .executeTakeFirstOrThrow();
      try {
        await db
          .updateTable(testCase.table)
          .set({ [testCase.column]: testCase.value })
          .where('id', '=', testCase.id)
          .execute();
        const response = await request(admin, {
          method: 'POST',
          url: '/invoice-requests/export',
          payload: standardPayload(),
          idempotencyKey: `phase5-inactive-master-${index}`,
        });
        expect(response.statusCode).toBe(422);
      } finally {
        await db
          .updateTable(testCase.table)
          .set({ [testCase.column]: original[testCase.column] })
          .where('id', '=', testCase.id)
          .execute();
      }
    }
    expect(await counts()).toEqual({ requests: 0, lines: 0, exports: 0, folio: 0 });
  });

  it('exporta STANDARD, persiste todo atómicamente y devuelve exactamente el BYTEA', async () => {
    const response = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: standardPayload(),
      idempotencyKey: 'phase5-standard-0001',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="Solicitud_factura_[A-Za-z0-9_.-]+\.xlsx"$/,
    );
    const requestId = response.headers['x-invoice-request-id'] as string;
    const sha256 = response.headers['x-export-sha256'];
    expect(response.headers['x-invoice-folio']).toBe('SF-2026-00001');
    expect(sha256).toBe(createHash('sha256').update(response.rawPayload).digest('hex'));

    const stored = await db
      .selectFrom('invoice_request as ir')
      .innerJoin('invoice_export as ie', 'ie.invoice_request_id', 'ir.id')
      .select([
        'ir.status',
        'ir.contract_number',
        'ir.net_clp',
        'ir.iva_clp',
        'ir.total_clp',
        'ir.calculation_algorithm_version',
        'ir.excel_template_version',
        'ie.content',
        'ie.sha256',
      ])
      .where('ir.id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      status: 'EXPORTED',
      contract_number: null,
      net_clp: '1248726',
      iva_clp: '237260',
      total_clp: '1485986',
      calculation_algorithm_version: 'LEGACY_V1',
      excel_template_version: 'SOLICITUD_FACTURA_CLONE_CANDIDATE_V1',
      sha256,
    });
    expect(Buffer.compare(stored.content, response.rawPayload)).toBe(0);
    expect(typeof stored.total_clp).toBe('string');
    expect(await counts()).toEqual({ requests: 1, lines: 2, exports: 1, folio: 1 });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(response.rawPayload).buffer);
    const sheet = workbook.getWorksheet('Hoja1');
    expect(sheet).toBeTruthy();
    expect(sheet?.getCell('C4').text).toBe('MAS CONSULTORES S.A.');
    expect(sheet?.getCell('C22').text).toBe('MAS Plataformas');
    expect(sheet?.getCell('C18').text).toContain('receiver.standard@example.invalid');
    expect(sheet?.getCell('C21').text).toBe('CP-P5-1\nCP-P5-2');
    expect(await readExactNumericCell(response.rawPayload, 'C15')).toBe('1248726');
    expect(await readExactNumericCell(response.rawPayload, 'C15')).not.toBe('1248727');
    expect(await readFormulaCell(response.rawPayload, 'C16')).toEqual({
      address: 'C16',
      formula: 'ROUNDUP((C15*19%),0)',
      cachedValue: '237260',
    });
    expect(await readFormulaCell(response.rawPayload, 'C17')).toEqual({
      address: 'C17',
      formula: 'C15+C16',
      cachedValue: '1485986',
    });
    expect(JSON.stringify(workbook.model)).not.toContain('SF-2026-00001');
    expect(
      await db
        .selectFrom('audit_event')
        .select('id')
        .where('action', '=', 'INVOICE_REQUEST_EXPORTED')
        .where('entity_id', '=', requestId)
        .executeTakeFirst(),
    ).toBeTruthy();
  });

  it('misma clave/payload devuelve archivo y folio exactos; payload distinto produce 409', async () => {
    const first = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: standardPayload(),
      idempotencyKey: 'phase5-standard-0001',
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-invoice-folio']).toBe('SF-2026-00001');
    const stored = await db
      .selectFrom('invoice_export')
      .select('content')
      .where('invoice_request_id', '=', first.headers['x-invoice-request-id'] as string)
      .executeTakeFirstOrThrow();
    expect(Buffer.compare(first.rawPayload, stored.content)).toBe(0);
    expect(await counts()).toEqual({ requests: 1, lines: 2, exports: 1, folio: 1 });

    const changed = { ...standardPayload(), description: 'Payload diferente' };
    const conflict = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: changed,
      idempotencyKey: 'phase5-standard-0001',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await counts()).folio).toBe(1);
  });

  it('doble clic concurrente crea una solicitud y reserva un solo folio', async () => {
    const key = 'phase5-concurrent-0001';
    const payload = { ...standardPayload(), description: 'Exportación concurrente ficticia' };
    const [left, right] = await Promise.all([
      request(coordinator, {
        method: 'POST',
        url: '/invoice-requests/export',
        payload,
        idempotencyKey: key,
      }),
      request(coordinator, {
        method: 'POST',
        url: '/invoice-requests/export',
        payload,
        idempotencyKey: key,
      }),
    ]);
    expect([left.statusCode, right.statusCode]).toEqual([200, 200]);
    expect(left.headers['x-invoice-request-id']).toBe(right.headers['x-invoice-request-id']);
    expect(left.headers['x-invoice-folio']).toBe(right.headers['x-invoice-folio']);
    expect(Buffer.compare(left.rawPayload, right.rawPayload)).toBe(0);
    expect(await counts()).toEqual({ requests: 2, lines: 4, exports: 2, folio: 2 });
  });

  it('un fallo de generación anterior a la transacción no crea filas ni consume folio', async () => {
    const before = await counts();
    const failing = await buildServer({
      env,
      db,
      version: '0.5.0-failing-renderer',
      invoiceWorkbookRenderer: {
        generateAndValidate: () => Promise.reject(new Error('Fallo XLSX simulado')),
      },
    });
    await failing.ready();
    try {
      const response = await failing.inject({
        method: 'POST',
        url: '/invoice-requests/export',
        headers: {
          cookie: admin.cookie,
          'x-csrf-token': admin.csrf,
          'idempotency-key': 'phase5-render-fail-01',
        },
        payload: { ...standardPayload(), description: 'Fallo de renderer ficticio' },
      });
      expect(response.statusCode).toBe(500);
      expect(await counts()).toEqual(before);
    } finally {
      await failing.close();
    }
  });

  it('un fallo crítico de auditoría revierte solicitud, archivo, líneas y folio', async () => {
    const before = await counts();
    const owner = await connect(database.ownerUri);
    try {
      await owner.query(`
        CREATE FUNCTION reject_phase5_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'INVOICE_REQUEST_EXPORTED' THEN
            RAISE EXCEPTION 'audit failure requested by test';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_phase5_audit_trigger
          BEFORE INSERT ON audit_event
          FOR EACH ROW EXECUTE FUNCTION reject_phase5_audit();
      `);
      const response = await request(admin, {
        method: 'POST',
        url: '/invoice-requests/export',
        payload: { ...standardPayload(), description: 'Rollback de auditoría ficticio' },
        idempotencyKey: 'phase5-audit-fail-001',
      });
      expect(response.statusCode).toBe(500);
      expect(await counts()).toEqual(before);
    } finally {
      await owner.query('DROP TRIGGER IF EXISTS reject_phase5_audit_trigger ON audit_event');
      await owner.query('DROP FUNCTION IF EXISTS reject_phase5_audit()');
      await owner.end();
    }
  });

  it('detecta conflicto UF antes de reservar el folio', async () => {
    const before = await counts();
    const response = await request(admin, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: { ...standardPayload(), ufValue: '40543.08' },
      idempotencyKey: 'phase5-uf-conflict-01',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UF_VALUE_CHANGED');
    expect(await counts()).toEqual(before);
  });

  it('exporta HABITAT exento para COORDINATOR sin inferir por nombre', async () => {
    const payload: InvoiceRequestExportInput = {
      ...standardPayload(),
      clientId: habitatClientId,
      taxTreatment: 'EXEMPT',
      purchaseOrderNumber: 'OC-H-1',
      contractNumber: 'CONTRATO-H-1',
      hesNumber: 'HES-H-1',
      description: 'Variante ficticia',
      lines: [{ projectCenterId: habitatCenter, ufAmount: '1', position: 1 }],
      receivers: [
        {
          receiverId: habitatReceiverId,
          displayName: 'Receptor Variante',
          email: 'receiver.variant@example.invalid',
          position: 1,
        },
      ],
    };
    const response = await request(coordinator, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload,
      idempotencyKey: 'phase5-habitat-0001',
    });
    expect(response.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(response.rawPayload).buffer);
    const sheet = workbook.getWorksheet('Hoja1')!;
    expect(sheet.getCell('B12').text).toBe('OC / N° Contrato');
    expect(sheet.getCell('C12').text).toBe('OC: OC-H-1 / Contrato: CONTRATO-H-1');
    expect(sheet.getCell('C13').text).toBe('HES-H-1');
    expect(sheet.getCell('C4').text).toBe('MAS CONSULTORES S.A.');
    expect(sheet.getCell('C15').text).toBe('');
    expect(sheet.getCell('C16').text).toBe('');
    expect(await readExactNumericCell(response.rawPayload, 'C16')).toBeNull();
    expect(await readExactNumericCell(response.rawPayload, 'C17')).toBe('40543');
    expect(await listFormulaCells(response.rawPayload)).toEqual([]);
  });

  it('duplicar sólo precarga memoria y al exportar obtiene nuevo folio con vínculo de origen', async () => {
    const original = await db
      .selectFrom('invoice_request')
      .select(['id', 'folio'])
      .where('idempotency_key', '=', 'phase5-standard-0001')
      .executeTakeFirstOrThrow();
    const beforeSource = await counts();
    const sourceResponse = await request(coordinator, {
      method: 'GET',
      url: `/invoice-requests/${original.id}/duplicate-source`,
    });
    expect(sourceResponse.statusCode).toBe(200);
    expect(await counts()).toEqual(beforeSource);
    const source = sourceResponse.json<{ source: InvoiceRequestExportInput }>().source;
    expect(source.sourceRequestId).toBe(original.id);
    expect(JSON.stringify(source)).not.toContain(original.folio);
    expect(JSON.stringify(source)).not.toContain('sha256');

    const duplicated = await request(coordinator, {
      method: 'POST',
      url: '/invoice-requests/export',
      payload: { ...source, description: 'Duplicación ficticia' },
      idempotencyKey: 'phase5-duplicate-0001',
    });
    expect(duplicated.statusCode).toBe(200);
    expect(duplicated.headers['x-invoice-folio']).not.toBe(original.folio);
    const row = await db
      .selectFrom('invoice_request')
      .select(['source_request_id', 'folio'])
      .where('id', '=', duplicated.headers['x-invoice-request-id'] as string)
      .executeTakeFirstOrThrow();
    expect(row.source_request_id).toBe(original.id);
    expect(row.folio).not.toBe(original.folio);
  });

  it('historial/detalle no exponen BYTEA o idempotencia y descarga los bytes exactos con auditoría', async () => {
    const filtered = await request(coordinator, {
      method: 'GET',
      url: '/invoice-requests?taxTreatment=EXEMPT&billingFrom=2026-07-01&billingTo=2026-07-31&status=EXPORTED',
    });
    expect(filtered.statusCode).toBe(200);
    expect(
      filtered
        .json<{ items: Array<{ taxTreatment: string; billingDate: string }> }>()
        .items.every(
          (item) => item.taxTreatment === 'EXEMPT' && item.billingDate.startsWith('2026-07-'),
        ),
    ).toBe(true);

    const requestRow = await db
      .selectFrom('invoice_request')
      .select('id')
      .where('idempotency_key', '=', 'phase5-standard-0001')
      .executeTakeFirstOrThrow();
    const list = await request(admin, { method: 'GET', url: '/invoice-requests?q=Standard' });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
    const detail = await request(coordinator, {
      method: 'GET',
      url: `/invoice-requests/${requestRow.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain('idempotency');
    expect(detail.body).not.toContain('payload_hash');
    expect(detail.body).not.toContain('content');

    const stored = await db
      .selectFrom('invoice_export')
      .select('content')
      .where('invoice_request_id', '=', requestRow.id)
      .executeTakeFirstOrThrow();
    const downloaded = await request(coordinator, {
      method: 'GET',
      url: `/invoice-requests/${requestRow.id}/export`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(Buffer.compare(downloaded.rawPayload, stored.content)).toBe(0);
    expect(
      await db
        .selectFrom('audit_event')
        .select('id')
        .where('action', '=', 'INVOICE_EXPORT_DOWNLOADED')
        .where('entity_id', '=', requestRow.id)
        .executeTakeFirst(),
    ).toBeTruthy();
    const audit = JSON.stringify(
      await db
        .selectFrom('audit_event')
        .select(['action', 'metadata'])
        .where('entity', '=', 'invoice_request')
        .execute(),
    );
    expect(audit).not.toContain('phase5-standard-0001');
    for (const forbidden of ['password', 'token', 'csrf', 'cookie', 'idempotency', 'content']) {
      expect(audit.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('preserva snapshots ante cambios de maestros posteriores', async () => {
    const requestRow = await db
      .selectFrom('invoice_request')
      .select('id')
      .where('idempotency_key', '=', 'phase5-standard-0001')
      .executeTakeFirstOrThrow();
    const center = await db
      .selectFrom('project_center')
      .select('product_id')
      .where('id', '=', centerOne)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('client')
      .set({ short_name: 'Cliente Renombrado Ficticio' })
      .where('id', '=', standardClientId)
      .execute();
    await db
      .updateTable('coordinator_profile')
      .set({ display_name: 'Responsable Renombrado Ficticio' })
      .where('id', '=', coordinatorProfileId)
      .execute();
    await db
      .updateTable('issuer_company')
      .set({ legal_name: 'Emisora Renombrada Ficticia SpA' })
      .where('id', '=', issuerId)
      .execute();
    await db
      .updateTable('receiver')
      .set({ email: 'receiver.changed@example.invalid' })
      .where('id', '=', standardReceiverId)
      .execute();
    await db
      .updateTable('project_center')
      .set({ code: 'CP-RENAMED', project_name: 'Proyecto Renombrado Ficticio' })
      .where('id', '=', centerOne)
      .execute();
    await db
      .updateTable('product')
      .set({ name: 'Producto Renombrado Ficticio' })
      .where('id', '=', center.product_id)
      .execute();
    const detail = await request(admin, {
      method: 'GET',
      url: `/invoice-requests/${requestRow.id}`,
    });
    const historic = detail.json<{
      invoiceRequest: {
        clientShortName: string;
        issuerCompanyLegalName: string;
        coordinatorDisplayName: string;
        lines: Array<{ projectCenterCode: string; projectName: string; productName: string }>;
        receivers: Array<{ email: string }>;
      };
    }>().invoiceRequest;
    expect(historic).toMatchObject({
      clientShortName: 'Cliente Standard Ficticio',
      issuerCompanyLegalName: 'Emisora Ficticia SpA',
      coordinatorDisplayName: 'Responsable Ficticio',
    });
    expect(historic.lines[0]).toMatchObject({
      projectCenterCode: 'CP-P5-1',
      projectName: 'Proyecto ficticio uno',
      productName: 'Producto Ficticio',
    });
    expect(historic.receivers[0]?.email).toBe('receiver.standard@example.invalid');
  });

  it('PostgreSQL conserva ownership y bloquea UPDATE/DELETE/TRUNCATE operativos', async () => {
    const owner = await connect(database.ownerUri);
    const appClient = await connect(database.appUri);
    try {
      const tables = [
        'invoice_request',
        'invoice_request_line',
        'invoice_request_receiver',
        'invoice_export',
      ];
      for (const table of tables) {
        const ownership = await owner.query<{ owner: string }>(
          'SELECT tableowner AS owner FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
          ['public', table],
        );
        expect(ownership.rows[0]?.owner).toBe('factuflow_owner');
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
          const result = await owner.query<{ allowed: boolean }>(
            'SELECT has_table_privilege($1, $2, $3) AS allowed',
            ['factuflow_app', table, privilege],
          );
          expect(result.rows[0]?.allowed).toBe(false);
        }
      }
      await expect(appClient.query('UPDATE invoice_request SET status = status')).rejects.toSatisfy(
        (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
      );
      await expect(appClient.query('DELETE FROM invoice_export')).rejects.toSatisfy(
        (error: unknown) => isPgError(error) && error.code === INSUFFICIENT_PRIVILEGE,
      );

      const mutableColumn = await owner.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'invoice_request' AND column_name = 'updated_at'
         ) AS present`,
      );
      expect(mutableColumn.rows[0]?.present).toBe(false);
      const statusConstraint = await owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'public.invoice_request'::regclass AND contype = 'c'`,
      );
      expect(
        statusConstraint.rows.some((row) => row.definition.includes("status = 'EXPORTED'")),
      ).toBe(true);
      const forbiddenTables = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND (table_name LIKE '%draft%' OR table_name LIKE '%purchase_order%' OR table_name LIKE '%approval%')`,
      );
      expect(forbiddenTables.rows).toEqual([]);
    } finally {
      await owner.end();
      await appClient.end();
    }

    const constraints = await db
      .selectFrom('invoice_request')
      .select(sql<string>`count(id)`.as('total'))
      .where('status', 'in', ['EXPORTED'])
      .executeTakeFirstOrThrow();
    expect(Number(constraints.total)).toBe((await counts()).requests);
  });

  it('OpenAPI publica exportación, historial, descarga y duplicación', async () => {
    const openapi = await app.inject({ method: 'GET', url: '/docs/json' });
    const paths = openapi.json<{ paths: Record<string, unknown> }>().paths;
    expect(paths).toHaveProperty('/invoice-requests/export');
    expect(paths).toHaveProperty('/invoice-requests');
    expect(paths).toHaveProperty('/invoice-requests/{id}');
    expect(paths).toHaveProperty('/invoice-requests/{id}/export');
    expect(paths).toHaveProperty('/invoice-requests/{id}/duplicate-source');
  });
});
