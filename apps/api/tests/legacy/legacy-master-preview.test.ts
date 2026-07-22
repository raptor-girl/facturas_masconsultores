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
});
