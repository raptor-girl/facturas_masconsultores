import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runLegacyMasterPreview } from '../../src/infrastructure/legacy/legacy-master-preview.js';
import { calculateChileanRutCheckDigit } from '../../src/domain/billing/chilean-rut.js';

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'factuflow-legacy-preview-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('preview local de maestros legacy', () => {
  it('genera reportes bloqueados y sin overrides si la fuente no existe', async () => {
    const root = await tempRoot();
    const report = await runLegacyMasterPreview({
      sourcePath: join(root, 'missing.sql'),
      outputDir: join(root, 'reports'),
      mode: 'DRY_RUN',
    });

    expect(report.status).toBe('BLOCKED');
    expect(report.totals).toMatchObject({ files: 0, tables: 0, blocking: 1 });
    expect(report.issues[0]?.code).toBe('SOURCE_NOT_FOUND');
    expect(report.reports.overridesDraft).toBeNull();
    await expect(readFile(join(root, 'reports', 'summary.md'), 'utf8')).resolves.toContain(
      'No se detectaron archivos',
    );
  });

  it('analiza un SQL ficticio, enmascara datos y prepara overrides accionables', async () => {
    const root = await tempRoot();
    const rutBody = '77123456';
    const rut = `${rutBody}-${calculateChileanRutCheckDigit(rutBody)}`;
    const source = join(root, 'bdmaster.sql');
    const overrides = join(root, 'import-overrides.draft.json');
    await writeFile(
      source,
      [
        'CREATE TABLE clientes (id INTEGER, nombre TEXT, rut TEXT, correo TEXT, producto TEXT, oc TEXT);',
        `INSERT INTO clientes (id, nombre, rut, correo, producto, oc) VALUES (1, 'Cliente Habitat Ficticio', '${rut}', 'facturacion@example.invalid', 'Talentos', 'OC-001');`,
      ].join('\n'),
      'utf8',
    );

    const report = await runLegacyMasterPreview({
      sourcePath: source,
      outputDir: join(root, 'reports'),
      overridesPath: overrides,
      mode: 'ANALYZE',
    });

    expect(report.status).toBe('READY_FOR_REVIEW');
    expect(report.source.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.tables).toHaveLength(1);
    expect(report.entities.client.detected).toBe(1);
    expect(report.entities.client_invoice_rule.warnings).toBe(1);
    expect(report.issues.some((issue) => issue.code === 'POSSIBLE_HABITAT_CLIENT')).toBe(true);
    const issues = await readFile(join(root, 'reports', 'issues.csv'), 'utf8');
    expect(issues).not.toContain('Cliente Habitat Ficticio');
    expect(issues).not.toContain('facturacion@example.invalid');
    await expect(readFile(overrides, 'utf8')).resolves.toContain('requires_user_decision');
  });

  it('acepta etiquetas legacy de tipo CP/MS y agrupa Habitat por cliente', async () => {
    const root = await tempRoot();
    const source = join(root, 'bdmaster.sql');
    const overrides = join(root, 'import-overrides.draft.json');
    await writeFile(
      source,
      [
        'CREATE TABLE catalogo_tipo_cp (codigo TEXT, nombre TEXT, activo INTEGER);',
        'CREATE TABLE cliente (id TEXT, nombre_corto TEXT, razon_social TEXT, rut TEXT, giro TEXT, direccion TEXT, requiere_hes INTEGER);',
        'CREATE TABLE receptor (id TEXT, cliente_id TEXT, nombre TEXT, email TEXT, activo INTEGER);',
        'CREATE TABLE cp (id TEXT, codigo TEXT, nombre TEXT, tipo_cp TEXT, cliente_id TEXT);',
        "INSERT INTO catalogo_tipo_cp (codigo, nombre, activo) VALUES ('ADMIN_OPERACION', 'Administracion y Operacion', 1), ('CONSTRUCCION', 'Construccion', 1), ('HORAS_DESARROLLO', 'Horas de Desarrollo', 1);",
        "INSERT INTO cliente (id, nombre_corto, razon_social, rut, giro, direccion, requiere_hes) VALUES ('cli_afp_habitat', 'AFP HABITAT', 'AFP HABITAT S.A.', '98.000.100-8', 'Servicios', 'Providencia 1909', 0);",
        "INSERT INTO receptor (id, cliente_id, nombre, email, activo) VALUES ('recep_1', 'cli_afp_habitat', 'Facturas', 'facturas@example.invalid', 1), ('recep_2', 'cli_afp_habitat', 'DTE', 'dte@example.invalid', 1);",
        "INSERT INTO cp (id, codigo, nombre, tipo_cp, cliente_id) VALUES ('cp_1', 'MS1', 'LMS', 'Administración y Operación', 'cli_afp_habitat'), ('cp_2', 'MS2', 'Construcción', 'Construcción', 'cli_afp_habitat'), ('cp_3', 'MS3', 'Horas', 'Horas de Desarrollo', 'cli_afp_habitat');",
      ].join('\n'),
      'utf8',
    );

    const report = await runLegacyMasterPreview({
      sourcePath: source,
      outputDir: join(root, 'reports'),
      overridesPath: overrides,
      mode: 'DRY_RUN',
    });

    expect(
      report.issues.filter((issue) => issue.code === 'PROJECT_CENTER_TYPE_UNKNOWN'),
    ).toHaveLength(0);
    expect(report.issues.filter((issue) => issue.code === 'POSSIBLE_HABITAT_CLIENT')).toHaveLength(
      1,
    );
    expect(report.entities.project_center.warnings).toBe(0);
    expect(report.entities.client_invoice_rule.warnings).toBe(2);
  });
});
