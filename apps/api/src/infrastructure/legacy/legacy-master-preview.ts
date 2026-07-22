import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { InvalidChileanRutError, normalizeChileanRut } from '../../domain/billing/chilean-rut.js';
import { normalizeProductName } from '../../domain/billing/product-name.js';

export type LegacyPreviewMode = 'ANALYZE' | 'DRY_RUN';
type SourceKind = 'SQL_DUMP' | 'ZIP_ARCHIVE' | 'XLSX' | 'XLS' | 'CSV' | 'UNKNOWN';
type Severity = 'info' | 'warning' | 'blocking';
type RecognizedEntity =
  | 'issuer_company'
  | 'coordinator_profile'
  | 'client'
  | 'client_invoice_rule'
  | 'receiver'
  | 'product'
  | 'project_center';

interface LegacyPreviewOptions {
  readonly sourcePath: string;
  readonly mode: LegacyPreviewMode;
  readonly outputDir?: string;
  readonly overridesPath?: string;
}

interface FileFinding {
  readonly path: string;
  readonly kind: SourceKind;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface TableFinding {
  readonly name: string;
  readonly columns: string[];
  readonly rowCountApprox: number;
  readonly recognizedEntities: RecognizedEntity[];
}

export interface LegacyPreviewIssue {
  readonly severity: Severity;
  readonly code: string;
  readonly entity: RecognizedEntity | null;
  readonly table: string | null;
  readonly rowNumber: number | null;
  readonly field: string | null;
  readonly message: string;
  readonly maskedValue: string | null;
  readonly requiresUserDecision: boolean;
}

interface EntityCounts {
  readonly detected: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly warnings: number;
  readonly blocking: number;
}

export interface LegacyPreviewReport {
  readonly status: 'READY_FOR_REVIEW' | 'BLOCKED';
  readonly mode: LegacyPreviewMode;
  readonly generatedAt: string;
  readonly source: {
    readonly path: string;
    readonly kind: SourceKind | null;
    readonly sizeBytes: number | null;
    readonly sha256: string | null;
  };
  readonly files: FileFinding[];
  readonly tables: TableFinding[];
  readonly entities: Record<RecognizedEntity, EntityCounts>;
  readonly issues: LegacyPreviewIssue[];
  readonly totals: {
    readonly files: number;
    readonly tables: number;
    readonly rowsApprox: number;
    readonly warnings: number;
    readonly blocking: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly reports: {
    readonly summary: string;
    readonly issues: string;
    readonly preview: string;
    readonly overridesDraft: string | null;
  };
}

interface InsertRow {
  readonly table: string;
  readonly rowNumber: number;
  readonly values: Record<string, string | null>;
}

const ENTITIES: readonly RecognizedEntity[] = [
  'issuer_company',
  'coordinator_profile',
  'client',
  'client_invoice_rule',
  'receiver',
  'product',
  'project_center',
];

const DEFAULT_OUT_DIR = 'tmp/legacy-import';
const DEFAULT_OVERRIDES_PATH = 'legacy-private/import-overrides.draft.json';
const MASTER_TABLE_ENTITIES: Readonly<Record<string, readonly RecognizedEntity[]>> = {
  empresa_emisora: ['issuer_company'],
  coordinador: ['coordinator_profile'],
  cliente: ['client', 'client_invoice_rule'],
  cliente_facturacion: ['client_invoice_rule'],
  receptor: ['receiver'],
  producto: ['product'],
  cp: ['project_center'],
};
const LEGACY_TECHNICAL_TABLES = new Set([
  'app_config',
  'app_session',
  'app_user',
  'asignacion_solicitud',
  'audit_log',
  'bitacora_integracion',
  'catalogo_estado_solicitud',
  'catalogo_tipo_cp',
  'catalogo_tipo_impuesto',
  'cliente_coordinador',
  'cliente_producto',
  'desarrollador',
  'documento_exportado',
  'historial_estado',
  'proyeccion',
  'proyeccion_auxiliar',
  'proyeccion_configuracion',
  'proyeccion_facturacion',
  'proyeccion_item',
  'proyeccion_mensual',
  'proyeccion_uf',
  'proyeccion_version',
  'registro_tiempo',
  'schema_migrations',
  'slack_notificacion_log',
  'solicitud_cp',
  'solicitud_factura',
  'solicitud_item',
  'solicitud_programada',
  'solicitud_receptor',
  'uf_cache',
  'version_plantilla',
]);

function emptyCounts(): EntityCounts {
  return {
    detected: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    warnings: 0,
    blocking: 0,
  };
}

function emptyEntityCounts(): Record<RecognizedEntity, EntityCounts> {
  return Object.fromEntries(ENTITIES.map((entity) => [entity, emptyCounts()])) as Record<
    RecognizedEntity,
    EntityCounts
  >;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function kindForPath(path: string): SourceKind {
  const extension = extname(path).toLowerCase();
  if (extension === '.sql') return 'SQL_DUMP';
  if (extension === '.zip') return 'ZIP_ARCHIVE';
  if (extension === '.xlsx') return 'XLSX';
  if (extension === '.xls') return 'XLS';
  if (extension === '.csv') return 'CSV';
  return 'UNKNOWN';
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/^["'`]/, '')
    .replace(/["'`]$/, '');
}

function canonicalTableName(raw: string): string {
  return raw
    .split('.')
    .map((part) => unquoteIdentifier(part))
    .at(-1)!
    .trim();
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  const normalized = normalizeName(value);
  return candidates.some((candidate) => normalized.includes(candidate));
}

function recognizeEntity(tableName: string, columns: readonly string[]): RecognizedEntity[] {
  const knownEntities = MASTER_TABLE_ENTITIES[tableName.toLowerCase()];
  if (knownEntities) return [...knownEntities];
  if (LEGACY_TECHNICAL_TABLES.has(tableName.toLowerCase())) return [];

  const joined = `${tableName} ${columns.join(' ')}`;
  const result: RecognizedEntity[] = [];
  if (includesAny(joined, ['emisor', 'issuer', 'empresa emisora', 'facturar por'])) {
    result.push('issuer_company');
  }
  if (includesAny(joined, ['responsable', 'coordinador', 'encargado', 'ejecutivo'])) {
    result.push('coordinator_profile');
  }
  if (includesAny(joined, ['cliente', 'client']) && includesAny(joined, ['rut', 'razon', 'giro'])) {
    result.push('client');
  }
  if (includesAny(joined, ['receptor', 'destinatario', 'correo', 'email'])) {
    result.push('receiver');
  }
  if (includesAny(joined, ['producto', 'product', 'servicio'])) {
    result.push('product');
  }
  if (includesAny(joined, ['centro', 'cp', 'proyecto', 'project center', 'ms'])) {
    result.push('project_center');
  }
  if (includesAny(joined, ['oc', 'orden', 'hes', 'contrato', 'supplier', 'proveedor'])) {
    result.push('client_invoice_rule');
  }
  return [...new Set(result)];
}

function decodeSql(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  const replacementCount = [...utf8].filter((character) => character === '\uFFFD').length;
  if (replacementCount > Math.max(2, utf8.length / 500)) return buffer.toString('latin1');
  return utf8;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "'" && inString && next === "'") {
      index += 1;
      continue;
    }
    if (character === "'") inString = !inString;
    if (character === ';' && !inString) {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function parseCreateTables(sql: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const createRegex =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+))?)\s*\(/giu;
  let match: RegExpExecArray | null;
  while ((match = createRegex.exec(sql)) !== null) {
    const rawTableName = match[1];
    if (!rawTableName) continue;
    const tableName = canonicalTableName(rawTableName);
    const start = match.index + match[0].length;
    let depth = 1;
    let inString = false;
    let end = start;
    for (; end < sql.length; end += 1) {
      const character = sql[end];
      const next = sql[end + 1];
      if (character === "'" && inString && next === "'") {
        end += 1;
        continue;
      }
      if (character === "'") inString = !inString;
      if (inString) continue;
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (depth === 0) break;
    }
    const body = sql.slice(start, end);
    tables.set(tableName, parseColumns(body));
  }
  return tables;
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (character === "'" && inString && next === "'") {
      index += 1;
      continue;
    }
    if (character === "'") inString = !inString;
    if (!inString) {
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (character === ',' && depth === 0) {
        parts.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function parseColumns(body: string): string[] {
  return splitTopLevelCommas(body)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(primary|foreign|unique|constraint|check|key)\b/iu.test(line))
    .map((line) => {
      const match = line.match(/^("[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/u);
      const column = match?.[1];
      return column ? unquoteIdentifier(column) : null;
    })
    .filter((column): column is string => column !== null);
}

function parseInsertStatements(sql: string): InsertRow[] {
  const rows: InsertRow[] = [];
  const rowCounters = new Map<string, number>();
  for (const statement of splitSqlStatements(sql)) {
    const match = statement.match(
      /^\s*insert\s+into\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+))?)\s*(?:\(([^)]*)\))?\s+values\s+([\s\S]*)$/iu,
    );
    if (!match) continue;
    const rawTableName = match[1];
    const valuesSql = match[3];
    if (!rawTableName || !valuesSql) continue;
    const table = canonicalTableName(rawTableName);
    const rawColumns = match[2];
    const columns = rawColumns
      ? splitTopLevelCommas(rawColumns).map((column) => unquoteIdentifier(column))
      : [];
    const tuples = parseTuples(valuesSql);
    for (const tuple of tuples) {
      const previous = rowCounters.get(table) ?? 0;
      const rowNumber = previous + 1;
      rowCounters.set(table, rowNumber);
      rows.push({
        table,
        rowNumber,
        values: Object.fromEntries(
          tuple.map((value, index) => [columns[index] ?? `column_${index + 1}`, value]),
        ),
      });
    }
  }
  return rows;
}

function parseCopyStatements(sql: string): {
  readonly rows: InsertRow[];
  readonly columnsByTable: Map<string, string[]>;
} {
  const rows: InsertRow[] = [];
  const columnsByTable = new Map<string, string[]>();
  const rowCounters = new Map<string, number>();
  const lines = sql.split(/\r?\n/u);
  const copyRegex =
    /^copy\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+))?)\s*\(([^)]*)\)\s+from\s+stdin;$/iu;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(copyRegex);
    if (!match) continue;
    const rawTableName = match[1];
    const rawColumns = match[2];
    if (!rawTableName || !rawColumns) continue;
    const table = canonicalTableName(rawTableName);
    const columns = splitTopLevelCommas(rawColumns).map((column) => unquoteIdentifier(column));
    columnsByTable.set(table, columns);

    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line === '\\.') break;
      const values = line.split('\t').map(parseCopyValue);
      const previous = rowCounters.get(table) ?? 0;
      const rowNumber = previous + 1;
      rowCounters.set(table, rowNumber);
      rows.push({
        table,
        rowNumber,
        values: Object.fromEntries(
          columns.map((column, valueIndex) => [column, values[valueIndex] ?? null]),
        ),
      });
    }
  }

  return { rows, columnsByTable };
}

function parseCopyValue(value: string): string | null {
  if (value === '\\N') return null;
  return value
    .replace(/\\\\/gu, '\\')
    .replace(/\\t/gu, '\t')
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\r');
}

function parseTuples(valuesSql: string): Array<Array<string | null>> {
  const tuples: Array<Array<string | null>> = [];
  let inString = false;
  let depth = 0;
  let tupleStart = -1;
  for (let index = 0; index < valuesSql.length; index += 1) {
    const character = valuesSql[index];
    const next = valuesSql[index + 1];
    if (character === "'" && inString && next === "'") {
      index += 1;
      continue;
    }
    if (character === "'") inString = !inString;
    if (inString) continue;
    if (character === '(') {
      if (depth === 0) tupleStart = index + 1;
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0 && tupleStart >= 0) {
        tuples.push(splitTopLevelCommas(valuesSql.slice(tupleStart, index)).map(parseSqlValue));
        tupleStart = -1;
      }
    }
  }
  return tuples;
}

function parseSqlValue(value: string): string | null {
  const trimmed = value.trim();
  if (/^null$/iu.test(trimmed)) return null;
  if (/^'.*'$/su.test(trimmed)) return trimmed.slice(1, -1).replace(/''/gu, "'");
  return trimmed;
}

function findField(row: InsertRow, names: readonly string[]): [string, string | null] | null {
  for (const [column, value] of Object.entries(row.values)) {
    if (includesAny(column, names)) return [column, value];
  }
  return null;
}

function maskRut(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/[^0-9kK]/gu, '');
  if (compact.length < 2) return '***';
  const bodyPrefix = compact.slice(0, Math.min(2, compact.length - 1));
  return `${bodyPrefix}.***.***-*`;
}

function maskEmail(value: string | null): string | null {
  if (!value) return null;
  const [local, domain] = value.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain.toLowerCase()}`;
}

function maskText(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 3) return `${trimmed.slice(0, 1)}***`;
  return `${trimmed.slice(0, 4)}***`;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

function isActiveLegacy(value: string | null): boolean {
  if (value === null) return true;
  return ['t', 'true', '1', 'si', 'sí', 's', 'activo'].includes(normalizeName(value.trim()));
}

function normalizedKey(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return normalizeName(trimmed).replace(/\s+/gu, ' ');
}

function rowValue(row: InsertRow, names: readonly string[]): string | null {
  return findField(row, names)?.[1] ?? null;
}

function incrementBy(
  entities: Record<RecognizedEntity, EntityCounts>,
  entity: RecognizedEntity,
  field: keyof EntityCounts,
  by: number,
): void {
  if (by <= 0) return;
  entities[entity] = { ...entities[entity], [field]: entities[entity][field] + by };
}

function addIssue(
  issues: LegacyPreviewIssue[],
  issue: Omit<LegacyPreviewIssue, 'message'> & { readonly message: string },
): void {
  issues.push(issue);
}

function increment(
  entities: Record<RecognizedEntity, EntityCounts>,
  entity: RecognizedEntity,
  field: keyof EntityCounts,
): void {
  entities[entity] = { ...entities[entity], [field]: entities[entity][field] + 1 };
}

function analyzeRows(
  tables: readonly TableFinding[],
  rows: readonly InsertRow[],
): {
  readonly entities: Record<RecognizedEntity, EntityCounts>;
  readonly issues: LegacyPreviewIssue[];
} {
  const entities = emptyEntityCounts();
  const issues: LegacyPreviewIssue[] = [];
  const tableEntities = new Map(tables.map((table) => [table.name, table.recognizedEntities]));
  const duplicateKeys = new Map<string, InsertRow[]>();
  const productNames = new Map<string, InsertRow[]>();
  const clientIds = new Set<string>();
  const projectCenterTypeCodes = new Set<string>();
  const cpRows: InsertRow[] = [];
  const receiverKeys = new Map<string, InsertRow[]>();
  const coordinatorNames = new Map<string, InsertRow[]>();
  const coordinatorEmails = new Map<string, InsertRow[]>();
  let clientRows = 0;
  let clientRowsWithHesRule = 0;
  let clientRowsMissingRut = 0;
  let clientRowsIncomplete = 0;

  for (const row of rows) {
    if (row.table === 'cliente') {
      clientRows += 1;
      const id = rowValue(row, ['id']);
      if (id) clientIds.add(id);
      if (rowValue(row, ['requiere_hes']) !== null) clientRowsWithHesRule += 1;
      if (rowValue(row, ['rut']) === null) clientRowsMissingRut += 1;
      if (
        rowValue(row, ['razon_social']) === null ||
        rowValue(row, ['giro']) === null ||
        rowValue(row, ['direccion']) === null
      ) {
        clientRowsIncomplete += 1;
      }
    }
    if (row.table === 'catalogo_tipo_cp') {
      const code = normalizedKey(rowValue(row, ['codigo']));
      if (code) projectCenterTypeCodes.add(code);
    }
  }

  for (const row of rows) {
    const recognized = tableEntities.get(row.table) ?? [];
    if (recognized.length === 0) continue;
    for (const entity of recognized) {
      increment(entities, entity, 'detected');
      increment(entities, entity, 'created');
    }

    const rutField = findField(row, ['rut', 'tax']);
    if (rutField) {
      const [field, value] = rutField;
      if (!value) {
        for (const entity of recognized.filter((item) =>
          ['client', 'issuer_company'].includes(item),
        )) {
          increment(entities, entity, 'warnings');
          addIssue(issues, {
            severity: 'warning',
            code: 'RUT_MISSING',
            entity,
            table: row.table,
            rowNumber: row.rowNumber,
            field,
            message: 'El RUT está ausente y requiere confirmación antes de una carga real.',
            maskedValue: null,
            requiresUserDecision: true,
          });
        }
      } else {
        try {
          const normalized = normalizeChileanRut(value);
          const duplicateKey = `rut:${normalized}`;
          duplicateKeys.set(duplicateKey, [...(duplicateKeys.get(duplicateKey) ?? []), row]);
        } catch (error) {
          if (!(error instanceof InvalidChileanRutError)) throw error;
          for (const entity of recognized.filter((item) =>
            ['client', 'issuer_company'].includes(item),
          )) {
            increment(entities, entity, 'blocking');
            increment(entities, entity, 'failed');
            addIssue(issues, {
              severity: 'blocking',
              code: 'RUT_INVALID',
              entity,
              table: row.table,
              rowNumber: row.rowNumber,
              field,
              message: 'El RUT no pasa la validación de dígito verificador.',
              maskedValue: maskRut(value),
              requiresUserDecision: true,
            });
          }
        }
      }
    }

    const emailField = findField(row, ['email', 'correo', 'mail']);
    if (emailField) {
      const [field, value] = emailField;
      if (value && !isValidEmail(value)) {
        for (const entity of recognized.filter((item) =>
          ['receiver', 'coordinator_profile'].includes(item),
        )) {
          increment(entities, entity, 'blocking');
          increment(entities, entity, 'failed');
          addIssue(issues, {
            severity: 'blocking',
            code: 'EMAIL_INVALID',
            entity,
            table: row.table,
            rowNumber: row.rowNumber,
            field,
            message: 'El correo no cumple formato básico.',
            maskedValue: maskEmail(value),
            requiresUserDecision: true,
          });
        }
      }
    }

    const productField =
      row.table === 'producto'
        ? findField(row, ['nombre', 'codigo'])
        : findField(row, ['producto', 'product', 'servicio']);
    if (productField?.[1]) {
      const normalizedProduct = normalizeProductName(productField[1]);
      productNames.set(normalizedProduct, [...(productNames.get(normalizedProduct) ?? []), row]);
    }

    const clientField = findField(row, ['cliente', 'client', 'razon', 'nombre']);
    if (clientField?.[1] && includesAny(clientField[1], ['habitat'])) {
      increment(entities, 'client_invoice_rule', 'warnings');
      addIssue(issues, {
        severity: 'warning',
        code: 'POSSIBLE_HABITAT_CLIENT',
        entity: 'client_invoice_rule',
        table: row.table,
        rowNumber: row.rowNumber,
        field: clientField[0],
        message:
          'El nombre sugiere Habitat, pero la variante Excel no debe inferirse automáticamente.',
        maskedValue: maskText(clientField[1]),
        requiresUserDecision: true,
      });
    }

    if (row.table === 'receptor') {
      const clientId = rowValue(row, ['cliente_id']);
      const email = rowValue(row, ['email', 'correo', 'mail']);
      if (clientId && email && isActiveLegacy(rowValue(row, ['activo']))) {
        const key = `${clientId}:${email.trim().toLowerCase()}`;
        receiverKeys.set(key, [...(receiverKeys.get(key) ?? []), row]);
      }
    }

    if (row.table === 'coordinador') {
      const nameKey = normalizedKey(rowValue(row, ['nombre']));
      if (nameKey) coordinatorNames.set(nameKey, [...(coordinatorNames.get(nameKey) ?? []), row]);
      const emailKey = rowValue(row, ['email', 'correo', 'mail'])?.trim().toLowerCase();
      if (emailKey) {
        coordinatorEmails.set(emailKey, [...(coordinatorEmails.get(emailKey) ?? []), row]);
      }
    }

    if (row.table === 'cp') cpRows.push(row);
  }

  if (clientRows > 0 && clientRowsWithHesRule > 0) {
    increment(entities, 'client_invoice_rule', 'warnings');
    addIssue(issues, {
      severity: 'warning',
      code: 'DOCUMENT_RULES_PARTIALLY_INFERRED',
      entity: 'client_invoice_rule',
      table: 'cliente',
      rowNumber: null,
      field: 'requiere_hes',
      message:
        'La fuente permite inferir HES para algunos clientes, pero OC y contrato no quedan plenamente definidos para apply sin revisión.',
      maskedValue: null,
      requiresUserDecision: true,
    });
  }

  if (clientRowsMissingRut > 0) {
    incrementBy(entities, 'client', 'warnings', clientRowsMissingRut);
    addIssue(issues, {
      severity: 'warning',
      code: 'CLIENT_RUT_MISSING_AGGREGATE',
      entity: 'client',
      table: 'cliente',
      rowNumber: null,
      field: 'rut',
      message:
        'Hay clientes sin RUT. Podrían cargarse como PENDING_COMPLETION sólo con decisión explícita.',
      maskedValue: `${clientRowsMissingRut} registro(s)`,
      requiresUserDecision: true,
    });
  }

  if (clientRowsIncomplete > 0) {
    incrementBy(entities, 'client', 'warnings', clientRowsIncomplete);
    addIssue(issues, {
      severity: 'warning',
      code: 'CLIENT_INCOMPLETE_AGGREGATE',
      entity: 'client',
      table: 'cliente',
      rowNumber: null,
      field: null,
      message:
        'Hay clientes con razón social, giro o dirección incompletos. Requieren confirmar data_status antes de apply.',
      maskedValue: `${clientRowsIncomplete} registro(s)`,
      requiresUserDecision: true,
    });
  }

  const cpRowsWithoutClient = cpRows.filter((row) => {
    const clientId = rowValue(row, ['cliente_id']);
    return !clientId || !clientIds.has(clientId);
  });
  if (cpRowsWithoutClient.length > 0) {
    incrementBy(entities, 'project_center', 'blocking', cpRowsWithoutClient.length);
    incrementBy(entities, 'project_center', 'failed', cpRowsWithoutClient.length);
    addIssue(issues, {
      severity: 'blocking',
      code: 'PROJECT_CENTER_CLIENT_MISSING',
      entity: 'project_center',
      table: 'cp',
      rowNumber: null,
      field: 'cliente_id',
      message: 'Hay CP/MS sin cliente válido dentro de la fuente legacy.',
      maskedValue: `${cpRowsWithoutClient.length} CP/MS`,
      requiresUserDecision: true,
    });
  }

  const cpRowsWithUnknownType = cpRows.filter((row) => {
    const type = normalizedKey(rowValue(row, ['tipo_cp']));
    return type !== null && projectCenterTypeCodes.size > 0 && !projectCenterTypeCodes.has(type);
  });
  if (cpRowsWithUnknownType.length > 0) {
    incrementBy(entities, 'project_center', 'warnings', cpRowsWithUnknownType.length);
    addIssue(issues, {
      severity: 'warning',
      code: 'PROJECT_CENTER_TYPE_UNKNOWN',
      entity: 'project_center',
      table: 'cp',
      rowNumber: null,
      field: 'tipo_cp',
      message:
        'Hay CP/MS con tipo no presente en catalogo_tipo_cp. Requiere override antes de apply.',
      maskedValue: `${cpRowsWithUnknownType.length} CP/MS`,
      requiresUserDecision: true,
    });
  }

  for (const [key, duplicateRows] of duplicateKeys.entries()) {
    if (duplicateRows.length <= 1) continue;
    const first = duplicateRows[0];
    if (!first) continue;
    const entity = recognizeEntity(first.table, Object.keys(first.values))[0];
    addIssue(issues, {
      severity: 'warning',
      code: 'DUPLICATE_RUT',
      entity: entity ?? null,
      table: first.table,
      rowNumber: first.rowNumber,
      field: 'rut',
      message: `RUT repetido ${duplicateRows.length} veces en la fuente.`,
      maskedValue: maskRut(key.replace('rut:', '')),
      requiresUserDecision: true,
    });
  }

  for (const [normalized, productRows] of productNames.entries()) {
    const first = productRows[0];
    if (!first) continue;
    const rawNames = new Set(
      productRows
        .map((row) => findField(row, ['producto', 'product', 'servicio'])?.[1])
        .filter((value): value is string => Boolean(value)),
    );
    if (rawNames.size > 1) {
      increment(entities, 'product', 'warnings');
      addIssue(issues, {
        severity: 'warning',
        code: 'PRODUCT_AMBIGUOUS_NORMALIZATION',
        entity: 'product',
        table: first.table,
        rowNumber: first.rowNumber,
        field: 'product',
        message: 'Varios textos de producto caen en la misma normalización canónica.',
        maskedValue: maskText(normalized),
        requiresUserDecision: true,
      });
    }
  }

  for (const duplicateRows of receiverKeys.values()) {
    if (duplicateRows.length <= 1) continue;
    const first = duplicateRows[0];
    if (!first) continue;
    increment(entities, 'receiver', 'warnings');
    addIssue(issues, {
      severity: 'warning',
      code: 'RECEIVER_DUPLICATE_ACTIVE_EMAIL',
      entity: 'receiver',
      table: 'receptor',
      rowNumber: first.rowNumber,
      field: 'email',
      message: 'El mismo correo aparece activo más de una vez para el mismo cliente.',
      maskedValue: maskEmail(rowValue(first, ['email', 'correo', 'mail'])),
      requiresUserDecision: true,
    });
  }

  for (const duplicateRows of coordinatorNames.values()) {
    if (duplicateRows.length <= 1) continue;
    const first = duplicateRows[0];
    if (!first) continue;
    increment(entities, 'coordinator_profile', 'warnings');
    addIssue(issues, {
      severity: 'warning',
      code: 'COORDINATOR_AMBIGUOUS_NAME',
      entity: 'coordinator_profile',
      table: 'coordinador',
      rowNumber: first.rowNumber,
      field: 'nombre',
      message: 'Hay responsables con nombres equivalentes tras normalización.',
      maskedValue: maskText(rowValue(first, ['nombre'])),
      requiresUserDecision: true,
    });
  }

  for (const duplicateRows of coordinatorEmails.values()) {
    if (duplicateRows.length <= 1) continue;
    const first = duplicateRows[0];
    if (!first) continue;
    increment(entities, 'coordinator_profile', 'warnings');
    addIssue(issues, {
      severity: 'warning',
      code: 'COORDINATOR_DUPLICATE_EMAIL',
      entity: 'coordinator_profile',
      table: 'coordinador',
      rowNumber: first.rowNumber,
      field: 'email',
      message: 'Hay responsables que comparten correo.',
      maskedValue: maskEmail(rowValue(first, ['email', 'correo', 'mail'])),
      requiresUserDecision: true,
    });
  }

  return { entities, issues };
}

async function discoverFiles(sourcePath: string): Promise<FileFinding[]> {
  const sourceRoot = resolve('legacy-private');
  const exists = await pathExists(sourceRoot);
  if (!exists) return [];
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await walk(sourceRoot);
  const findings: FileFinding[] = [];
  for (const file of files) {
    const buffer = await readFile(file);
    findings.push({
      path: relative(process.cwd(), file),
      kind: kindForPath(file),
      sizeBytes: buffer.length,
      sha256: sha256(buffer),
    });
  }
  if (findings.length === 0 && sourcePath) return [];
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function analyzeSource(sourcePath: string): Promise<{
  readonly source: LegacyPreviewReport['source'];
  readonly tables: TableFinding[];
  readonly rows: InsertRow[];
  readonly issues: LegacyPreviewIssue[];
}> {
  const absolute = resolve(sourcePath);
  if (!(await pathExists(absolute))) {
    return {
      source: { path: sourcePath, kind: null, sizeBytes: null, sha256: null },
      tables: [],
      rows: [],
      issues: [
        {
          severity: 'blocking',
          code: 'SOURCE_NOT_FOUND',
          entity: null,
          table: null,
          rowNumber: null,
          field: null,
          message: 'No existe el archivo fuente solicitado dentro del workspace.',
          maskedValue: null,
          requiresUserDecision: true,
        },
      ],
    };
  }

  const buffer = await readFile(absolute);
  const kind = kindForPath(absolute);
  const source = {
    path: relative(process.cwd(), absolute),
    kind,
    sizeBytes: buffer.length,
    sha256: sha256(buffer),
  };
  if (kind !== 'SQL_DUMP') {
    return {
      source,
      tables: [],
      rows: [],
      issues: [
        {
          severity: 'blocking',
          code: 'UNSUPPORTED_SOURCE_KIND',
          entity: null,
          table: null,
          rowNumber: null,
          field: null,
          message:
            'La inspección automática de Fase 6.1 soporta bdmaster.sql. Otros formatos quedan detectados pero requieren conversión controlada posterior.',
          maskedValue: null,
          requiresUserDecision: true,
        },
      ],
    };
  }

  const sql = decodeSql(buffer);
  const createTables = parseCreateTables(sql);
  const copy = parseCopyStatements(sql);
  const rows = [...parseInsertStatements(sql), ...copy.rows];
  const rowCountByTable = new Map<string, number>();
  for (const row of rows) rowCountByTable.set(row.table, (rowCountByTable.get(row.table) ?? 0) + 1);
  const tableNames = new Set([...createTables.keys(), ...rowCountByTable.keys()]);
  const tables = [...tableNames].sort().map((tableName) => {
    const columns =
      createTables.get(tableName) ??
      copy.columnsByTable.get(tableName) ??
      Object.keys(rows.find((row) => row.table === tableName)?.values ?? {});
    return {
      name: tableName,
      columns,
      rowCountApprox: rowCountByTable.get(tableName) ?? 0,
      recognizedEntities: recognizeEntity(tableName, columns),
    };
  });

  return { source, tables, rows, issues: [] };
}

function mergeIssues(
  left: readonly LegacyPreviewIssue[],
  right: readonly LegacyPreviewIssue[],
): LegacyPreviewIssue[] {
  return [...left, ...right];
}

function totals(
  files: readonly FileFinding[],
  tables: readonly TableFinding[],
  issues: readonly LegacyPreviewIssue[],
): LegacyPreviewReport['totals'] {
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const blocking = issues.filter((issue) => issue.severity === 'blocking').length;
  return {
    files: files.length,
    tables: tables.length,
    rowsApprox: tables.reduce((sum, table) => sum + table.rowCountApprox, 0),
    warnings,
    blocking,
    skipped: issues.filter((issue) => issue.code.includes('SKIPPED')).length,
    failed: blocking,
  };
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  if (!/[",\n\r]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '""')}"`;
}

function issuesCsv(issues: readonly LegacyPreviewIssue[]): string {
  const headers = [
    'severity',
    'code',
    'entity',
    'table',
    'row_number',
    'field',
    'message',
    'masked_value',
    'requires_user_decision',
  ];
  const rows = issues.map((issue) =>
    [
      issue.severity,
      issue.code,
      issue.entity,
      issue.table,
      issue.rowNumber,
      issue.field,
      issue.message,
      issue.maskedValue,
      issue.requiresUserDecision,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${headers.join(',')}\n${rows.join('\n')}\n`;
}

function markdownSummary(report: LegacyPreviewReport): string {
  const tableRows = report.tables.map(
    (table) =>
      `| ${table.name} | ${table.rowCountApprox} | ${table.columns.length} | ${
        table.recognizedEntities.join(', ') || 'no reconocida'
      } |`,
  );
  const entityRows = ENTITIES.map((entity) => {
    const counts = report.entities[entity];
    return `| ${entity} | ${counts.detected} | ${counts.created} | ${counts.updated} | ${counts.unchanged} | ${counts.skipped} | ${counts.failed} | ${counts.warnings} | ${counts.blocking} |`;
  });
  return [
    '# Preview controlado de maestros legacy',
    '',
    `Estado: ${report.status}`,
    `Modo: ${report.mode}`,
    `Generado: ${report.generatedAt}`,
    '',
    '## Fuente',
    '',
    `- Archivo: ${report.source.path}`,
    `- Tipo: ${report.source.kind ?? 'no disponible'}`,
    `- SHA-256: ${report.source.sha256 ?? 'no disponible'}`,
    `- Tamaño: ${report.source.sizeBytes ?? 'no disponible'} bytes`,
    '',
    '## Archivos privados detectados',
    '',
    report.files.length
      ? report.files
          .map(
            (file) =>
              `- ${file.path} (${file.kind}, ${file.sizeBytes} bytes, sha256 ${file.sha256})`,
          )
          .join('\n')
      : '- No se detectaron archivos en legacy-private/.',
    '',
    '## Tablas detectadas',
    '',
    '| tabla | filas aprox. | columnas | entidades reconocidas |',
    '| --- | ---: | ---: | --- |',
    ...(tableRows.length ? tableRows : ['| n/a | 0 | 0 | n/a |']),
    '',
    '## Preview por entidad',
    '',
    '| entidad | detected | created | updated | unchanged | skipped | failed | warnings | blocking |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...entityRows,
    '',
    '## Issues',
    '',
    `- Warnings: ${report.totals.warnings}`,
    `- Bloqueantes: ${report.totals.blocking}`,
    '',
    report.issues.length
      ? 'Ver `issues.csv` para el detalle enmascarado. No se incluyen datos personales completos.'
      : 'No se detectaron issues.',
    '',
    '## No mutación',
    '',
    'Este reporte fue generado por análisis local/dry-run. No ejecuta apply, no crea maestros, no crea usuarios, no crea solicitudes y no reserva folios.',
    '',
  ].join('\n');
}

function overridesDraft(issues: readonly LegacyPreviewIssue[]): string | null {
  const decisions = issues.filter(
    (issue) =>
      issue.requiresUserDecision &&
      (issue.entity !== null || issue.code === 'POSSIBLE_HABITAT_CLIENT'),
  );
  if (decisions.length === 0) return null;
  return JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      note: 'Borrador privado. No versionar. Completar sólo con decisiones aprobadas por la usuaria.',
      productOverrides: decisions
        .filter((issue) => issue.entity === 'product')
        .map((issue) => ({
          issue_code: issue.code,
          table: issue.table,
          row_number: issue.rowNumber,
          canonical_product: null,
          requires_user_decision: true,
        })),
      projectCenterTypeOverrides: decisions
        .filter((issue) => issue.entity === 'project_center')
        .map((issue) => ({
          issue_code: issue.code,
          table: issue.table,
          row_number: issue.rowNumber,
          project_center_type: null,
          requires_user_decision: true,
        })),
      habitatClientOverrides: decisions
        .filter((issue) => issue.code === 'POSSIBLE_HABITAT_CLIENT')
        .map((issue) => ({
          table: issue.table,
          row_number: issue.rowNumber,
          excel_template_variant: null,
          requires_user_decision: true,
        })),
      documentRuleOverrides: decisions
        .filter((issue) => issue.entity === 'client_invoice_rule')
        .map((issue) => ({
          issue_code: issue.code,
          table: issue.table,
          row_number: issue.rowNumber,
          purchase_order_requirement: null,
          hes_requirement: null,
          contract_requirement: null,
          requires_user_decision: true,
        })),
      coordinatorOverrides: decisions
        .filter((issue) => issue.entity === 'coordinator_profile')
        .map((issue) => ({
          issue_code: issue.code,
          table: issue.table,
          row_number: issue.rowNumber,
          coordinator_external_id: null,
          requires_user_decision: true,
        })),
      clientOverrides: decisions
        .filter((issue) => issue.entity === 'client')
        .map((issue) => ({
          issue_code: issue.code,
          table: issue.table,
          row_number: issue.rowNumber,
          data_status: null,
          is_active: null,
          requires_user_decision: true,
        })),
    },
    null,
    2,
  );
}

async function writeReports(
  report: Omit<LegacyPreviewReport, 'reports'>,
  outputDir: string,
  overridesPath: string,
): Promise<LegacyPreviewReport> {
  await mkdir(outputDir, { recursive: true });
  const summaryPath = resolve(outputDir, 'summary.md');
  const issuesPath = resolve(outputDir, 'issues.csv');
  const previewPath = resolve(outputDir, 'preview.json');
  const draft = overridesDraft(report.issues);
  const finalReport: LegacyPreviewReport = {
    ...report,
    reports: {
      summary: relative(process.cwd(), summaryPath),
      issues: relative(process.cwd(), issuesPath),
      preview: relative(process.cwd(), previewPath),
      overridesDraft: draft ? relative(process.cwd(), resolve(overridesPath)) : null,
    },
  };
  await writeFile(summaryPath, markdownSummary(finalReport), 'utf8');
  await writeFile(issuesPath, issuesCsv(finalReport.issues), 'utf8');
  await writeFile(previewPath, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  if (draft) {
    await mkdir(dirname(resolve(overridesPath)), { recursive: true });
    await writeFile(resolve(overridesPath), `${draft}\n`, 'utf8');
  }
  return finalReport;
}

export async function runLegacyMasterPreview(
  options: LegacyPreviewOptions,
): Promise<LegacyPreviewReport> {
  const outputDir = options.outputDir ?? DEFAULT_OUT_DIR;
  const overridesPath = options.overridesPath ?? DEFAULT_OVERRIDES_PATH;
  const files = await discoverFiles(options.sourcePath);
  const analyzed = await analyzeSource(options.sourcePath);
  const rowAnalysis = analyzeRows(analyzed.tables, analyzed.rows);
  const issues = mergeIssues(analyzed.issues, rowAnalysis.issues);
  for (const table of analyzed.tables.filter((item) => item.recognizedEntities.length === 0)) {
    issues.push({
      severity: 'info',
      code: 'TABLE_NOT_RECOGNIZED',
      entity: null,
      table: table.name,
      rowNumber: null,
      field: null,
      message: 'La tabla no tiene un mapeo automático de maestros en Fase 6.1.',
      maskedValue: null,
      requiresUserDecision: true,
    });
  }
  const reportBase = {
    status: issues.some((issue) => issue.severity === 'blocking')
      ? ('BLOCKED' as const)
      : ('READY_FOR_REVIEW' as const),
    mode: options.mode,
    generatedAt: new Date().toISOString(),
    source: analyzed.source,
    files,
    tables: analyzed.tables,
    entities: rowAnalysis.entities,
    issues,
    totals: totals(files, analyzed.tables, issues),
  };
  return writeReports(reportBase, outputDir, overridesPath);
}

export function humanResult(report: LegacyPreviewReport): string {
  return [
    `Estado: ${report.status}`,
    `Fuente: ${report.source.path}`,
    `SHA-256: ${report.source.sha256 ?? 'no disponible'}`,
    `Tablas detectadas: ${report.totals.tables}`,
    `Filas aproximadas: ${report.totals.rowsApprox}`,
    `Warnings: ${report.totals.warnings}`,
    `Bloqueantes: ${report.totals.blocking}`,
    `Reportes: ${report.reports.summary}, ${report.reports.issues}, ${report.reports.preview}`,
    report.reports.overridesDraft ? `Overrides draft: ${report.reports.overridesDraft}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function defaultSourcePath(): string {
  return resolve('legacy-private', 'bdmaster.sql');
}

export function supportedPrivateSourceName(path: string): boolean {
  return basename(resolve(path)).toLowerCase() === 'bdmaster.sql';
}
