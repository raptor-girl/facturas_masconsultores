import JSZip from 'jszip';

const FIXED_ARCHIVE_DATE = new Date('2000-01-01T00:00:00.000Z');
const WORKSHEET_PATH = 'xl/worksheets/sheet1.xml';

export interface ExactNumericCell {
  readonly address: string;
  readonly canonicalInteger: string;
  readonly sentinel: string;
}

export interface ExactFormulaCell extends ExactNumericCell {
  readonly formula: string;
}

export interface FormulaCell {
  readonly address: string;
  readonly formula: string;
  readonly cachedValue: string | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readCellBody(worksheetXml: string, address: string): string | null {
  const addressPattern = escapeRegExp(address);
  const selfClosingPattern = new RegExp(`<c\\b(?=[^>]*\\br="${addressPattern}")[^>]*/>`);
  if (selfClosingPattern.test(worksheetXml)) {
    return null;
  }

  const pattern = new RegExp(`<c\\b(?=[^>]*\\br="${addressPattern}")[^>]*>([\\s\\S]*?)<\\/c>`);
  return worksheetXml.match(pattern)?.[1] ?? null;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

async function loadArchive(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes, { checkCRC32: true });
}

function normalizeEntryDates(archive: JSZip): void {
  for (const entry of Object.values(archive.files)) {
    entry.date = FIXED_ARCHIVE_DATE;
  }
}

async function serializeArchive(archive: JSZip): Promise<Buffer> {
  normalizeEntryDates(archive);
  return archive.generateAsync({
    type: 'nodebuffer',
    platform: 'DOS',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function normalizeXlsxArchive(bytes: Uint8Array): Promise<Buffer> {
  return serializeArchive(await loadArchive(bytes));
}

function sharedStringIndex(sharedStringsXml: string, sentinel: string): string {
  const items = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)];
  const index = items.findIndex((match) => match[1]?.includes(sentinel));
  if (index < 0) throw new Error(`No se encontro el marcador exacto ${sentinel}.`);
  return String(index);
}

export async function writeExactNumericCells(
  bytes: Uint8Array,
  cells: readonly ExactNumericCell[],
): Promise<Buffer> {
  const archive = await loadArchive(bytes);
  const worksheetEntry = archive.file(WORKSHEET_PATH);
  const sharedStringsEntry = archive.file('xl/sharedStrings.xml');
  if (!worksheetEntry || !sharedStringsEntry) {
    throw new Error('El XLSX no contiene la hoja o las cadenas compartidas esperadas.');
  }

  let worksheetXml = await worksheetEntry.async('string');
  let sharedStringsXml = await sharedStringsEntry.async('string');

  for (const cell of cells) {
    if (!/^[A-Z]+[1-9]\d*$/.test(cell.address)) {
      throw new Error(`Direccion XLSX no canonica: ${cell.address}.`);
    }
    if (!/^(?:0|[1-9]\d*)$/.test(cell.canonicalInteger)) {
      throw new Error(`Monto CLP no canonico para ${cell.address}.`);
    }

    const index = sharedStringIndex(sharedStringsXml, cell.sentinel);
    const cellPattern = new RegExp(
      `<c\\b([^>]*\\br="${escapeRegExp(cell.address)}"[^>]*)>([\\s\\S]*?)<\\/c>`,
    );
    const match = worksheetXml.match(cellPattern);
    if (!match || !match[1] || !match[2] || !match[2].includes(`<v>${index}</v>`)) {
      throw new Error(`No se encontro la celda exacta ${cell.address} en la hoja.`);
    }
    if (/<f(?:\s|>)/.test(match[2])) {
      throw new Error(`La celda monetaria ${cell.address} contiene una formula.`);
    }

    const attributes = match[1].replace(/\s+t="(?:s|str|inlineStr)"/g, '');
    worksheetXml = worksheetXml.replace(
      cellPattern,
      `<c${attributes}><v>${cell.canonicalInteger}</v></c>`,
    );
    // El marcador ya no queda ni siquiera como cadena compartida huerfana.
    sharedStringsXml = sharedStringsXml.replace(cell.sentinel, '');
  }

  archive.file(WORKSHEET_PATH, worksheetXml, { date: FIXED_ARCHIVE_DATE });
  archive.file('xl/sharedStrings.xml', sharedStringsXml, { date: FIXED_ARCHIVE_DATE });
  return serializeArchive(archive);
}

export async function writeExactFormulaCells(
  bytes: Uint8Array,
  cells: readonly ExactFormulaCell[],
): Promise<Buffer> {
  if (cells.length === 0) {
    return Buffer.from(bytes);
  }

  const archive = await loadArchive(bytes);
  const worksheetEntry = archive.file(WORKSHEET_PATH);
  const sharedStringsEntry = archive.file('xl/sharedStrings.xml');
  if (!worksheetEntry || !sharedStringsEntry) {
    throw new Error('El XLSX no contiene la hoja o las cadenas compartidas esperadas.');
  }

  let worksheetXml = await worksheetEntry.async('string');
  let sharedStringsXml = await sharedStringsEntry.async('string');

  for (const cell of cells) {
    if (!/^[A-Z]+[1-9]\d*$/.test(cell.address)) {
      throw new Error(`Direccion XLSX no canonica: ${cell.address}.`);
    }
    if (!/^(?:0|[1-9]\d*)$/.test(cell.canonicalInteger)) {
      throw new Error(`Monto CLP no canonico para ${cell.address}.`);
    }
    if (!/^[A-Z0-9()+\-*/%,.]+$/.test(cell.formula)) {
      throw new Error(`Formula no permitida para ${cell.address}.`);
    }

    const index = sharedStringIndex(sharedStringsXml, cell.sentinel);
    const cellPattern = new RegExp(
      `<c\\b([^>]*\\br="${escapeRegExp(cell.address)}"[^>]*)>([\\s\\S]*?)<\\/c>`,
    );
    const match = worksheetXml.match(cellPattern);
    if (!match || !match[1] || !match[2] || !match[2].includes(`<v>${index}</v>`)) {
      throw new Error(`No se encontro la celda exacta ${cell.address} en la hoja.`);
    }

    const attributes = match[1].replace(/\s+t="(?:s|str|inlineStr)"/g, '');
    worksheetXml = worksheetXml.replace(
      cellPattern,
      `<c${attributes}><f>${cell.formula}</f><v>${cell.canonicalInteger}</v></c>`,
    );
    // El marcador ya no queda ni siquiera como cadena compartida huerfana.
    sharedStringsXml = sharedStringsXml.replace(cell.sentinel, '');
  }

  archive.file(WORKSHEET_PATH, worksheetXml, { date: FIXED_ARCHIVE_DATE });
  archive.file('xl/sharedStrings.xml', sharedStringsXml, { date: FIXED_ARCHIVE_DATE });
  return serializeArchive(archive);
}

export async function readXlsxEntry(bytes: Uint8Array, path: string): Promise<string | null> {
  const entry = (await loadArchive(bytes)).file(path);
  return entry ? entry.async('string') : null;
}

export async function listXlsxEntries(bytes: Uint8Array): Promise<readonly string[]> {
  return Object.keys((await loadArchive(bytes)).files).sort();
}

export async function readExactNumericCell(
  bytes: Uint8Array,
  address: string,
): Promise<string | null> {
  const worksheetXml = await readXlsxEntry(bytes, WORKSHEET_PATH);
  if (!worksheetXml) return null;
  const cell = readCellBody(worksheetXml, address);
  if (!cell || /<f(?:\s|>)/.test(cell)) return null;
  return cell.match(/<v>(\d+)<\/v>/)?.[1] ?? null;
}

export async function readFormulaCell(
  bytes: Uint8Array,
  address: string,
): Promise<FormulaCell | null> {
  const worksheetXml = await readXlsxEntry(bytes, WORKSHEET_PATH);
  if (!worksheetXml) return null;
  const cell = readCellBody(worksheetXml, address);
  const formulaMatch = cell?.match(/<f(?:\s[^>]*)?>([^<]*)<\/f>/);

  if (!cell || !formulaMatch) {
    return null;
  }

  return {
    address,
    formula: decodeXml(formulaMatch[1] ?? ''),
    cachedValue: cell.match(/<v>(-?\d+(?:\.\d+)?)<\/v>/)?.[1] ?? null,
  };
}

export async function listFormulaCells(bytes: Uint8Array): Promise<readonly FormulaCell[]> {
  const worksheetXml = await readXlsxEntry(bytes, WORKSHEET_PATH);
  if (!worksheetXml) return [];

  const formulas: FormulaCell[] = [];
  const pattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(worksheetXml)) !== null) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const address = attributes.match(/\br="([^"]+)"/)?.[1];
    const formulaMatch = body.match(/<f(?:\s[^>]*)?>([^<]*)<\/f>/);

    if (address && formulaMatch) {
      formulas.push({
        address,
        formula: decodeXml(formulaMatch[1] ?? ''),
        cachedValue: body.match(/<v>(-?\d+(?:\.\d+)?)<\/v>/)?.[1] ?? null,
      });
    }
  }

  return formulas;
}
