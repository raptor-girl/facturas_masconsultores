import ExcelJS from '@excel.js/exceljs';
import {
  INVOICE_EXPORT_MAX_BYTES,
  INVOICE_TECHNICAL_TEMPLATE_VERSION,
  INVOICE_XLSX_MIME,
} from '@factuflow/shared-schemas';
import type {
  GeneratedInvoiceWorkbook,
  InvoiceWorkbookData,
  InvoiceWorkbookRenderer,
} from '../../application/invoice-requests/invoice-request-service.js';
import { sanitizeSpreadsheetText } from '../../domain/invoice-request/export-safety.js';

const SHEET_NAME = 'Solicitud de factura';
const FIXED_WORKBOOK_DATE = new Date('2000-01-01T00:00:00.000Z');

function displayDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) throw new Error('Fecha inválida al construir el XLSX.');
  return `${day}/${month}/${year}`;
}

function safe(value: string | null): string {
  return sanitizeSpreadsheetText(value ?? '');
}

function habitatReference(data: InvoiceWorkbookData): string {
  return [
    data.purchaseOrderNumber ? `OC: ${safe(data.purchaseOrderNumber)}` : '',
    data.contractNumber ? `Contrato: ${safe(data.contractNumber)}` : '',
  ]
    .filter(Boolean)
    .join(' / ');
}

function setConstantNumericFormula(
  sheet: ExcelJS.Worksheet,
  address: string,
  canonicalInteger: string,
): void {
  if (!/^\d+$/.test(canonicalInteger)) {
    throw new Error(`Monto CLP no canónico para ${address}.`);
  }
  // La fórmula la crea exclusivamente la aplicación desde un entero validado.
  // Evita convertir montos a number binario y Excel conserva una celda numérica.
  sheet.getCell(address).value = { formula: canonicalInteger };
  sheet.getCell(address).numFmt = '$#,##0';
}

function applyTechnicalStyles(sheet: ExcelJS.Worksheet, lastRow: number): void {
  sheet.columns = [{ width: 3 }, { width: 30 }, { width: 46 }, { width: 20 }, { width: 25 }];
  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  sheet.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
  sheet.getRow(1).height = 28;
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FF8A3B12' }, size: 12 };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE7D6' } };
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  for (let row = 3; row <= lastRow; row += 1) {
    sheet.getRow(row).alignment = { vertical: 'top', wrapText: true };
    const label = sheet.getCell(`B${String(row)}`);
    if (label.value !== null) label.font = { bold: true, color: { argb: 'FF17324D' } };
  }
  for (const address of ['C15', 'C16', 'C17']) {
    sheet.getCell(address).font = { bold: true, size: 12 };
    sheet.getCell(address).border = {
      top: { style: 'thin', color: { argb: 'FF6C7A89' } },
      bottom: { style: 'thin', color: { argb: 'FF6C7A89' } },
      left: { style: 'thin', color: { argb: 'FF6C7A89' } },
      right: { style: 'thin', color: { argb: 'FF6C7A89' } },
    };
  }
}

function buildWorkbook(data: InvoiceWorkbookData): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FactuFlow';
  workbook.lastModifiedBy = 'FactuFlow';
  workbook.created = FIXED_WORKBOOK_DATE;
  workbook.modified = FIXED_WORKBOOK_DATE;
  workbook.company = 'FactuFlow';
  workbook.title = 'Solicitud de factura — plantilla técnica';
  workbook.subject = INVOICE_TECHNICAL_TEMPLATE_VERSION;
  workbook.description =
    'Plantilla técnica de prueba. La fidelidad visual requiere la plantilla oficial aprobada.';

  const sheet = workbook.addWorksheet(SHEET_NAME, {
    properties: { tabColor: { argb: 'FF17324D' } },
  });
  sheet.mergeCells('A1:E1');
  sheet.getCell('A1').value = 'PLANTILLA TÉCNICA DE PRUEBA — PENDIENTE APROBACIÓN VISUAL';

  sheet.getCell('B4').value = 'Empresa emisora';
  sheet.getCell('C4').value = safe(data.issuerLegalName);
  sheet.getCell('D4').value = 'Fecha solicitud';
  sheet.getCell('E4').value = displayDate(data.requestDate);
  sheet.getCell('B5').value = 'Cliente';
  sheet.getCell('C5').value = safe(data.clientShortName);
  sheet.getCell('D5').value = 'Fecha facturación';
  sheet.getCell('E5').value = displayDate(data.billingDate);

  sheet.getCell('B8').value = 'Razón social';
  sheet.getCell('C8').value = safe(data.clientLegalName);
  sheet.getCell('D8').value = 'Período';
  sheet.getCell('E8').value = data.period;
  sheet.getCell('B9').value = 'RUT';
  sheet.getCell('C9').value = safe(data.clientTaxId);
  sheet.getCell('B10').value = 'Giro';
  sheet.getCell('C10').value = safe(data.clientBusinessActivity);
  sheet.getCell('B11').value = 'Dirección';
  sheet.getCell('C11').value = safe(data.clientAddress);

  if (data.templateVariant === 'HABITAT') {
    sheet.getCell('B12').value = 'OC / N° Contrato';
    sheet.getCell('C12').value = habitatReference(data);
  } else {
    sheet.getCell('B12').value = 'Orden de Compra/ Nota de Pedido';
    sheet.getCell('C12').value = safe(data.purchaseOrderNumber);
  }
  sheet.getCell('D12').value = 'N° proveedor';
  sheet.getCell('E12').value = safe(data.supplierNumber);
  sheet.getCell('B13').value = 'HES';
  sheet.getCell('C13').value = data.hesNumber ? safe(data.hesNumber) : 'N/A';
  sheet.getCell('D13').value = 'Contrato';
  sheet.getCell('E13').value = safe(data.contractNumber);
  sheet.getCell('B14').value = 'Glosa';
  sheet.getCell('C14').value = safe(data.description);
  sheet.getCell('B15').value = 'Neto';
  setConstantNumericFormula(sheet, 'C15', data.netClp);
  sheet.getCell('B16').value = 'IVA';
  setConstantNumericFormula(sheet, 'C16', data.ivaClp);
  sheet.getCell('B17').value = 'Total';
  setConstantNumericFormula(sheet, 'C17', data.totalClp);
  sheet.getCell('D15').value = 'Tratamiento';
  sheet.getCell('E15').value = data.taxTreatment;

  sheet.getCell('B18').value = 'RECEPTORES DEL DOCUMENTO';
  sheet.getCell('C18').value = [...data.receivers]
    .sort((left, right) => left.position - right.position)
    .map((receiver) => {
      const name = receiver.displayName ? `${safe(receiver.displayName)} — ` : '';
      return `${String(receiver.position)}. ${name}${safe(receiver.email)}`;
    })
    .join('\n');
  sheet.getCell('C18').alignment = { vertical: 'top', wrapText: true };
  sheet.getRow(18).height = Math.max(24, data.receivers.length * 18);

  sheet.getCell('B20').value = 'Fecha UF';
  sheet.getCell('C20').value = displayDate(data.ufDate);
  sheet.getCell('D20').value = 'Valor UF';
  sheet.getCell('E20').value = data.ufValue;

  const orderedLines = [...data.lines].sort((left, right) => left.position - right.position);
  orderedLines.forEach((line, index) => {
    const row = 21 + index;
    sheet.getCell(`B${String(row)}`).value = index === 0 ? 'Centro de Proyecto' : '';
    sheet.getCell(`C${String(row)}`).value =
      `${safe(line.projectCenterCode)} — ${safe(line.projectName)}`;
    sheet.getCell(`D${String(row)}`).value = `${line.ufAmount} UF`;
    setConstantNumericFormula(sheet, `E${String(row)}`, line.clpAmount);
  });

  const offset = Math.max(orderedLines.length, 1) - 1;
  sheet.getCell(`B${String(22 + offset)}`).value = 'Área';
  sheet.getCell(`C${String(22 + offset)}`).value = data.area;
  sheet.getCell(`B${String(23 + offset)}`).value = 'Encargado';
  sheet.getCell(`C${String(23 + offset)}`).value = safe(data.coordinatorDisplayName);
  sheet.getCell(`B${String(24 + offset)}`).value = 'Observaciones';
  const observations = [
    data.observations ? safe(data.observations) : '',
    `Valor UF ${displayDate(data.ufDate)}: ${data.ufValue}`,
  ]
    .filter(Boolean)
    .join('\n');
  sheet.getCell(`C${String(24 + offset)}`).value = observations;

  applyTechnicalStyles(sheet, 24 + offset);
  return workbook;
}

async function validateWorkbook(bytes: Uint8Array, expected: InvoiceWorkbookData): Promise<void> {
  if (!bytes.length || bytes.length > INVOICE_EXPORT_MAX_BYTES) {
    throw new Error('El XLSX generado excede el límite permitido o está vacío.');
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new Error('El archivo generado no es ZIP/XLSX.');

  const archiveIndex = Buffer.from(bytes).toString('latin1');
  for (const forbidden of ['vbaProject.bin', 'externalLinks/', 'connections.xml']) {
    if (archiveIndex.includes(forbidden)) throw new Error(`El XLSX contiene ${forbidden}.`);
  }

  const parsed = new ExcelJS.Workbook();
  await parsed.xlsx.load(Uint8Array.from(bytes).buffer);
  if (parsed.worksheets.length !== 1) throw new Error('El XLSX debe tener exactamente una hoja.');
  const sheet = parsed.getWorksheet(SHEET_NAME);
  if (!sheet || sheet.state !== 'visible') throw new Error('La hoja de solicitud no es visible.');
  if (sheet.getCell('A1').text !== 'PLANTILLA TÉCNICA DE PRUEBA — PENDIENTE APROBACIÓN VISUAL') {
    throw new Error('La plantilla técnica perdió su marca de no aprobación.');
  }
  if (sheet.getCell('C4').text !== sanitizeSpreadsheetText(expected.issuerLegalName)) {
    throw new Error('El emisor no quedó en la celda validada.');
  }
  if (sheet.getCell('C5').text !== sanitizeSpreadsheetText(expected.clientShortName)) {
    throw new Error('El cliente no quedó en la celda validada.');
  }
  const expectedB12 =
    expected.templateVariant === 'HABITAT' ? 'OC / N° Contrato' : 'Orden de Compra/ Nota de Pedido';
  if (sheet.getCell('B12').text !== expectedB12) throw new Error('La variante XLSX es inválida.');
  if (sheet.getCell('C13').text !== (expected.hesNumber ? safe(expected.hesNumber) : 'N/A')) {
    throw new Error('HES no quedó en C13.');
  }
  for (const address of ['C15', 'C16', 'C17']) {
    const formula = sheet.getCell(address).formula;
    if (!formula || !/^\d+$/.test(formula)) {
      throw new Error(`La celda monetaria ${address} no contiene una fórmula local segura.`);
    }
  }
}

export class TechnicalInvoiceWorkbookRenderer implements InvoiceWorkbookRenderer {
  async generateAndValidate(data: InvoiceWorkbookData): Promise<GeneratedInvoiceWorkbook> {
    const workbook = buildWorkbook(data);
    const raw = await workbook.xlsx.writeBuffer({
      zip: { compression: 'DEFLATE', compressionOptions: { level: 6 } },
    });
    const bytes = Buffer.from(raw);
    await validateWorkbook(bytes, data);
    return {
      bytes,
      mimeType: INVOICE_XLSX_MIME,
      templateVersion: INVOICE_TECHNICAL_TEMPLATE_VERSION,
    };
  }
}
