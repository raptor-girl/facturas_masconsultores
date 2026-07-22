import ExcelJS from '@excel.js/exceljs';
import { readFile } from 'node:fs/promises';
import {
  INVOICE_CANDIDATE_TEMPLATE_VERSION,
  INVOICE_EXPORT_MAX_BYTES,
  INVOICE_XLSX_MIME,
} from '@factuflow/shared-schemas';
import type {
  GeneratedInvoiceWorkbook,
  InvoiceWorkbookData,
  InvoiceWorkbookLine,
  InvoiceWorkbookReceiver,
  InvoiceWorkbookRenderer,
} from '../../application/invoice-requests/invoice-request-service.js';
import { sanitizeSpreadsheetText } from '../../domain/invoice-request/export-safety.js';
import { applyNeutralWorkbookProperties, TEMPLATE_CLP_FORMAT } from './invoice-template-layout.js';
import {
  INVOICE_TEMPLATE_FILE_NAME,
  INVOICE_TEMPLATE_MAP,
  resolveInvoiceTemplateMap,
} from './invoice-template-map.js';
import {
  listFormulaCells,
  listXlsxEntries,
  readExactNumericCell,
  readFormulaCell,
  readXlsxEntry,
  writeExactFormulaCells,
  writeExactNumericCells,
  type ExactFormulaCell,
  type ExactNumericCell,
} from './xlsx-archive.js';

const DEFAULT_TEMPLATE_URL = new URL(
  `../../../../../templates/approved/${INVOICE_TEMPLATE_FILE_NAME}`,
  import.meta.url,
);

const TECHNICAL_TEXTS_NOT_VISIBLE = [
  'Fecha de Facturación',
  'Periodo',
  'Período',
  'Fecha UF',
  'Valor UF',
  'N° de Proveedor',
  'Número de Proveedor',
  'Producto ficticio',
  'Cantidad UF',
  'Tipo de CP',
  'CENTROS DE PROYECTO',
  'RECEPTORES DEL DOCUMENTO',
] as const;

const VISIBLE_ISSUER_COMPANY = 'MAS CONSULTORES S.A.';
const VISIBLE_AREA = 'MAS Plataformas';
const IVA_FORMULA = 'ROUNDUP((C15*19%),0)';
const TOTAL_FORMULA = 'C15+C16';

interface WorkbookFillPlan {
  readonly exactCells: ExactNumericCell[];
  readonly formulaCells: ExactFormulaCell[];
}

function displayDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) throw new Error('Fecha invalida al construir el XLSX.');
  return `${day}/${month}/${year}`;
}

function safe(value: string | null): string {
  return sanitizeSpreadsheetText(value ?? '');
}

function orderedReceivers(data: InvoiceWorkbookData): readonly InvoiceWorkbookReceiver[] {
  return [...data.receivers].sort((left, right) => left.position - right.position);
}

function orderedLines(data: InvoiceWorkbookData): readonly InvoiceWorkbookLine[] {
  return [...data.lines].sort((left, right) => left.position - right.position);
}

function receiverDisplay(receiver: InvoiceWorkbookReceiver): string {
  const displayName = safe(receiver.displayName);
  const email = safe(receiver.email);
  return displayName ? `${displayName} - ${email}` : email;
}

function formatClpText(canonicalInteger: string): string {
  if (!/^(?:0|[1-9]\d*)$/.test(canonicalInteger)) {
    throw new Error('Monto CLP no canonico al construir texto visible.');
  }
  return `$${canonicalInteger.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function habitatReference(data: InvoiceWorkbookData): string {
  return `OC: ${safe(data.purchaseOrderNumber)} / Contrato: ${safe(data.contractNumber)}`;
}

function setText(sheet: ExcelJS.Worksheet, address: string, value: string): void {
  const cell = sheet.getCell(address);
  cell.value = value;
  cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
}

function setExactClp(
  sheet: ExcelJS.Worksheet,
  address: string,
  canonicalInteger: string,
  exactCells: ExactNumericCell[],
): void {
  if (!/^(?:0|[1-9]\d*)$/.test(canonicalInteger)) {
    throw new Error(`Monto CLP no canonico para ${address}.`);
  }
  const sentinel = `__FACTUFLOW_EXACT_${address}_${canonicalInteger}__`;
  const cell = sheet.getCell(address);
  cell.value = sentinel;
  cell.numFmt = TEMPLATE_CLP_FORMAT;
  exactCells.push({ address, canonicalInteger, sentinel });
}

function setExactFormulaClp(
  sheet: ExcelJS.Worksheet,
  address: string,
  formula: string,
  canonicalInteger: string,
  formulaCells: ExactFormulaCell[],
): void {
  if (!/^(?:0|[1-9]\d*)$/.test(canonicalInteger)) {
    throw new Error(`Monto CLP no canonico para ${address}.`);
  }
  const sentinel = `__FACTUFLOW_FORMULA_${address}_${canonicalInteger}__`;
  const cell = sheet.getCell(address);
  cell.value = sentinel;
  cell.numFmt = TEMPLATE_CLP_FORMAT;
  formulaCells.push({ address, canonicalInteger, sentinel, formula });
}

function clearCellValue(sheet: ExcelJS.Worksheet, address: string): void {
  sheet.getCell(address).value = null;
}

function applyMultilineHeight(
  sheet: ExcelJS.Worksheet,
  row: number,
  baseHeight: number,
  lines: number,
): void {
  sheet.getRow(row).height = Math.max(baseHeight, baseHeight + Math.max(0, lines - 1) * 15);
}

function fillProjectCenters(
  sheet: ExcelJS.Worksheet,
  data: InvoiceWorkbookData,
  exactCells: ExactNumericCell[],
): void {
  const lines = orderedLines(data);
  setText(
    sheet,
    INVOICE_TEMPLATE_MAP.cells.projectCenters,
    lines.map((line) => safe(line.projectCenterCode)).join('\n'),
  );
  applyMultilineHeight(
    sheet,
    INVOICE_TEMPLATE_MAP.rows.projectCenters,
    INVOICE_TEMPLATE_MAP.baseHeights.projectCenters,
    lines.length,
  );

  if (lines.length === 1) {
    setExactClp(
      sheet,
      INVOICE_TEMPLATE_MAP.cells.projectCenterAmounts,
      lines[0]!.clpAmount,
      exactCells,
    );
    return;
  }

  const amountCell = sheet.getCell(INVOICE_TEMPLATE_MAP.cells.projectCenterAmounts);
  amountCell.value = lines.map((line) => formatClpText(line.clpAmount)).join('\n');
  amountCell.alignment = { ...(amountCell.alignment ?? {}), wrapText: true };
}

function fillWorkbook(workbook: ExcelJS.Workbook, data: InvoiceWorkbookData): WorkbookFillPlan {
  applyNeutralWorkbookProperties(workbook);
  const sheet = workbook.getWorksheet(INVOICE_TEMPLATE_MAP.sheetName);
  if (!sheet || workbook.worksheets.length !== 1 || sheet.state !== 'visible') {
    throw new Error('La plantilla clonada no contiene su unica hoja visible Hoja1.');
  }
  if (sheet.getCell(INVOICE_TEMPLATE_MAP.cells.title).text !== INVOICE_TEMPLATE_MAP.titleText) {
    throw new Error('La plantilla clonada no contiene el titulo esperado.');
  }
  if (sheet.pageSetup.printArea !== INVOICE_TEMPLATE_MAP.printArea) {
    throw new Error('La plantilla clonada no conserva el area de impresion esperada.');
  }

  const map = resolveInvoiceTemplateMap(data.templateVariant);
  const exactCells: ExactNumericCell[] = [];
  const formulaCells: ExactFormulaCell[] = [];

  sheet.getCell(INVOICE_TEMPLATE_MAP.labels.purchaseOrder).value =
    INVOICE_TEMPLATE_MAP.variants[data.templateVariant].purchaseOrderLabel;
  sheet.getCell(INVOICE_TEMPLATE_MAP.labels.hes).value = 'HES';
  sheet.getCell(INVOICE_TEMPLATE_MAP.labels.iva).value = 'Monto IVA';

  setText(sheet, map.issuerCompany, VISIBLE_ISSUER_COMPANY);
  setText(sheet, map.clientShortName, safe(data.clientShortName));
  setText(sheet, map.clientLegalName, safe(data.clientLegalName));
  setText(sheet, map.clientTaxId, safe(data.clientTaxId));
  setText(sheet, map.clientBusinessActivity, safe(data.clientBusinessActivity));
  setText(sheet, map.clientAddress, safe(data.clientAddress));
  setText(
    sheet,
    map.purchaseOrder,
    data.templateVariant === 'HABITAT' ? habitatReference(data) : safe(data.purchaseOrderNumber),
  );
  setText(sheet, map.hes, safe(data.hesNumber));
  setText(sheet, map.description, safe(data.description));
  if (data.taxTreatment === 'AFFECTED') {
    setExactClp(sheet, map.net, data.netClp, exactCells);
    setExactFormulaClp(sheet, map.iva, IVA_FORMULA, data.ivaClp, formulaCells);
    setExactFormulaClp(sheet, map.total, TOTAL_FORMULA, data.totalClp, formulaCells);
  } else {
    clearCellValue(sheet, map.net);
    clearCellValue(sheet, map.iva);
    setExactClp(sheet, map.total, data.totalClp, exactCells);
  }

  const receivers = orderedReceivers(data);
  setText(sheet, map.receivers, receivers.map(receiverDisplay).join('\n'));
  applyMultilineHeight(
    sheet,
    INVOICE_TEMPLATE_MAP.rows.receivers,
    INVOICE_TEMPLATE_MAP.baseHeights.receivers,
    receivers.length,
  );

  setText(sheet, map.requestDate, displayDate(data.requestDate));
  fillProjectCenters(sheet, data, exactCells);
  setText(sheet, map.area, VISIBLE_AREA);
  setText(sheet, map.coordinator, safe(data.coordinatorDisplayName));
  setText(sheet, map.observations, safe(data.observations));

  return { exactCells, formulaCells };
}

async function workbookText(bytes: Uint8Array): Promise<string> {
  const sharedStrings = await readXlsxEntry(bytes, 'xl/sharedStrings.xml');
  const worksheet = await readXlsxEntry(bytes, 'xl/worksheets/sheet1.xml');
  return `${sharedStrings ?? ''}\n${worksheet ?? ''}`;
}

async function validateWorkbook(bytes: Uint8Array, expected: InvoiceWorkbookData): Promise<void> {
  if (!bytes.length || bytes.length > INVOICE_EXPORT_MAX_BYTES) {
    throw new Error('El XLSX generado excede el limite permitido o esta vacio.');
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('El archivo generado no es ZIP/XLSX.');
  }

  const archiveEntries = await listXlsxEntries(bytes);
  const entries = archiveEntries.map((entry) => entry.toLowerCase());
  const forbidden = [
    'xl/vbaproject.bin',
    'xl/connections.xml',
    'xl/externallinks/',
    'xl/embeddings/',
    'xl/activex/',
  ];
  for (const candidate of forbidden) {
    if (entries.some((entry) => entry === candidate || entry.startsWith(candidate))) {
      throw new Error(`El XLSX contiene contenido prohibido: ${candidate}.`);
    }
  }

  const worksheetXml = await readXlsxEntry(bytes, 'xl/worksheets/sheet1.xml');
  if (!worksheetXml) {
    throw new Error('El XLSX no contiene la hoja esperada.');
  }
  for (const path of archiveEntries.filter((entry) => entry.toLowerCase().endsWith('.rels'))) {
    const relationships = await readXlsxEntry(bytes, path);
    if (relationships && /TargetMode="External"/i.test(relationships)) {
      throw new Error('El XLSX contiene una relacion externa.');
    }
  }

  const parsed = new ExcelJS.Workbook();
  await parsed.xlsx.load(Uint8Array.from(bytes).buffer);
  const sheet = parsed.getWorksheet(INVOICE_TEMPLATE_MAP.sheetName);
  if (!sheet || parsed.worksheets.length !== 1 || sheet.state !== 'visible') {
    throw new Error('El XLSX debe tener exactamente una hoja visible Hoja1.');
  }
  if (
    parsed.creator !== 'FactuFlow' ||
    parsed.lastModifiedBy !== 'FactuFlow' ||
    parsed.title !== 'Solicitud de Factura' ||
    parsed.subject !== INVOICE_CANDIDATE_TEMPLATE_VERSION
  ) {
    throw new Error('El XLSX no conserva metadatos neutrales.');
  }
  if (sheet.pageSetup.printArea !== INVOICE_TEMPLATE_MAP.printArea) {
    throw new Error('El XLSX no conserva el area de impresion clonada.');
  }

  const map = resolveInvoiceTemplateMap(expected.templateVariant);
  if (sheet.getCell(map.issuerCompany).text !== VISIBLE_ISSUER_COMPANY) {
    throw new Error('El emisor no quedo en la celda validada.');
  }
  if (sheet.getCell(map.area).text !== VISIBLE_AREA) {
    throw new Error('El area no quedo en la celda validada.');
  }
  if (sheet.getCell(map.clientShortName).text !== safe(expected.clientShortName)) {
    throw new Error('El cliente no quedo en la celda validada.');
  }
  if (
    sheet.getCell(INVOICE_TEMPLATE_MAP.labels.purchaseOrder).text !==
    INVOICE_TEMPLATE_MAP.variants[expected.templateVariant].purchaseOrderLabel
  ) {
    throw new Error('La variante XLSX es invalida.');
  }
  if (sheet.getCell(map.hes).text !== safe(expected.hesNumber)) {
    throw new Error('HES no quedo en C13.');
  }
  if (
    expected.templateVariant === 'STANDARD' &&
    sheet.getCell(map.purchaseOrder).text.includes('Contrato:')
  ) {
    throw new Error('STANDARD no debe imprimir contrato visible.');
  }
  if (sheet.getCell(map.projectCenters).text.includes('Producto')) {
    throw new Error('El XLSX no debe imprimir producto en la zona CP/MS.');
  }
  if (sheet.getCell(map.receivers).text.startsWith("'")) {
    throw new Error('La neutralizacion de formula no debe dejar apostrofe visible.');
  }
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.value === null || cell.value === undefined) return;
      if (cell.text === '41') throw new Error('El XLSX contiene el valor accidental 41.');
    });
  });

  const exactExpected = new Map<string, string>();
  const allowedFormulas = new Map<string, { formula: string; cachedValue: string }>();
  if (expected.taxTreatment === 'AFFECTED') {
    exactExpected.set(map.net, expected.netClp);
    allowedFormulas.set(map.iva, { formula: IVA_FORMULA, cachedValue: expected.ivaClp });
    allowedFormulas.set(map.total, { formula: TOTAL_FORMULA, cachedValue: expected.totalClp });
  } else {
    exactExpected.set(map.total, expected.totalClp);
    if (sheet.getCell(map.net).text !== '' || sheet.getCell(map.iva).text !== '') {
      throw new Error(
        'La solicitud exenta solo debe mostrar el monto total en montos principales.',
      );
    }
  }
  if (expected.lines.length === 1) {
    exactExpected.set(map.projectCenterAmounts, expected.lines[0]!.clpAmount);
  }
  for (const [address, value] of exactExpected) {
    if ((await readExactNumericCell(bytes, address)) !== value) {
      throw new Error(`La celda monetaria ${address} no conserva el entero exacto.`);
    }
  }
  const formulaCells = await listFormulaCells(bytes);
  if (formulaCells.length !== allowedFormulas.size) {
    throw new Error('El XLSX contiene una cantidad de formulas no controlada.');
  }
  for (const formulaCell of formulaCells) {
    const expectedFormula = allowedFormulas.get(formulaCell.address);
    if (
      !expectedFormula ||
      formulaCell.formula !== expectedFormula.formula ||
      formulaCell.cachedValue !== expectedFormula.cachedValue
    ) {
      throw new Error(`La formula de ${formulaCell.address} no esta permitida o no coincide.`);
    }
  }
  for (const [address, expectedFormula] of allowedFormulas) {
    const formulaCell = await readFormulaCell(bytes, address);
    if (
      !formulaCell ||
      formulaCell.formula !== expectedFormula.formula ||
      formulaCell.cachedValue !== expectedFormula.cachedValue
    ) {
      throw new Error(`La formula controlada ${address} no conserva su valor esperado.`);
    }
  }

  const text = await workbookText(bytes);
  for (const forbiddenText of TECHNICAL_TEXTS_NOT_VISIBLE) {
    if (text.includes(forbiddenText)) {
      throw new Error(`El XLSX contiene un campo tecnico no visible: ${forbiddenText}.`);
    }
  }
}

export class CandidateInvoiceWorkbookRenderer implements InvoiceWorkbookRenderer {
  readonly #templateBytes: Uint8Array | undefined;

  constructor(templateBytes?: Uint8Array) {
    this.#templateBytes = templateBytes;
  }

  async generateAndValidate(data: InvoiceWorkbookData): Promise<GeneratedInvoiceWorkbook> {
    const templateBytes = this.#templateBytes ?? (await readFile(DEFAULT_TEMPLATE_URL));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(templateBytes).buffer);
    const { exactCells, formulaCells } = fillWorkbook(workbook, data);
    const raw = await workbook.xlsx.writeBuffer({
      zip: { compression: 'DEFLATE', compressionOptions: { level: 6 } },
    });
    const numericBytes = await writeExactNumericCells(Buffer.from(raw), exactCells);
    const bytes = await writeExactFormulaCells(numericBytes, formulaCells);
    await validateWorkbook(bytes, data);
    return {
      bytes,
      mimeType: INVOICE_XLSX_MIME,
      templateVersion: INVOICE_CANDIDATE_TEMPLATE_VERSION,
    };
  }
}
