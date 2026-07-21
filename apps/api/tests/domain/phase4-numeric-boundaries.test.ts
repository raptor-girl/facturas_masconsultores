import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = [
  resolve(apiRoot, 'src/domain/calculation/decimal.ts'),
  resolve(apiRoot, 'src/domain/calculation/invoice-calculation.ts'),
  resolve(apiRoot, 'src/infrastructure/postgres/uf-service.ts'),
  resolve(apiRoot, '..', 'web', 'src', 'CalculationPreview.tsx'),
  resolve(apiRoot, '..', '..', 'packages', 'shared-schemas', 'src', 'uf.ts'),
];

describe('guardia: bordes numéricos de Fase 4', () => {
  it('no introducen conversión binaria ni redondeo Math en montos y UF', async () => {
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    for (const forbidden of [
      /parseFloat\s*\(/,
      /\bNumber\s*\(/,
      /Math\.(?:round|ceil|floor)\s*\(/,
      /type=["']number["']/,
      /Intl\.NumberFormat/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});
