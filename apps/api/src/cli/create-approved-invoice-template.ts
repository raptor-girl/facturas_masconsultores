import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  INVOICE_TEMPLATE_FILE_NAME,
  INVOICE_TEMPLATE_MAP,
} from '../infrastructure/excel/invoice-template-map.js';
import { listXlsxEntries, readXlsxEntry } from '../infrastructure/excel/xlsx-archive.js';

const templateUrl = new URL(
  `../../../../templates/approved/${INVOICE_TEMPLATE_FILE_NAME}`,
  import.meta.url,
);

async function main(): Promise<void> {
  const bytes = await readFile(templateUrl);
  const entries = await listXlsxEntries(bytes);
  const worksheetXml = await readXlsxEntry(bytes, 'xl/worksheets/sheet1.xml');
  const workbookXml = await readXlsxEntry(bytes, 'xl/workbook.xml');
  if (!worksheetXml || !workbookXml?.includes(INVOICE_TEMPLATE_MAP.sheetName)) {
    throw new Error('La plantilla clonada no contiene la hoja esperada.');
  }
  if (/<f(?:\s|>)/.test(worksheetXml)) {
    throw new Error('La plantilla clonada contiene formulas.');
  }
  if (
    entries.some((entry) =>
      /(?:vbaProject\.bin|externalLinks\/|connections\.xml|embeddings\/|activex\/)/i.test(entry),
    )
  ) {
    throw new Error('La plantilla clonada contiene contenido activo o externo.');
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  process.stdout.write(
    `Plantilla clonada verificada: ${fileURLToPath(templateUrl)}\nSHA-256: ${sha256}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : 'No se pudo verificar la plantilla clonada.'}\n`,
  );
  process.exitCode = 1;
});
