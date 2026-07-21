import ExcelJS from '@excel.js/exceljs';
import { describe, expect, it } from 'vitest';
import type { InvoiceWorkbookData } from '../../src/application/invoice-requests/invoice-request-service.js';
import { TechnicalInvoiceWorkbookRenderer } from '../../src/infrastructure/excel/technical-invoice-workbook.js';

const base: InvoiceWorkbookData = {
  templateVariant: 'STANDARD',
  issuerLegalName: 'Emisora Ficticia SpA',
  clientShortName: 'Cliente Ficticio',
  clientLegalName: 'Cliente Ficticio SpA',
  clientTaxId: '123456785',
  clientBusinessActivity: 'Servicios de prueba',
  clientAddress: 'Calle Ficticia 123',
  purchaseOrderNumber: 'OC-TEST-1',
  contractNumber: 'CONTRATO-TEST-1',
  hesNumber: 'HES-TEST-1',
  supplierNumber: 'PROV-TEST-1',
  description: 'Servicio ficticio mensual',
  observations: 'Observación ficticia',
  area: 'Plataformas',
  coordinatorDisplayName: 'Responsable Ficticio',
  period: '2026-07',
  requestDate: '2026-07-10',
  billingDate: '2026-07-15',
  ufDate: '2026-07-10',
  ufValue: '40543.07',
  taxTreatment: 'AFFECTED',
  netClp: '1248726',
  ivaClp: '237260',
  totalClp: '1485986',
  lines: [
    {
      position: 1,
      projectCenterCode: 'CP-TEST-1',
      projectName: 'Proyecto ficticio uno',
      productName: 'Producto ficticio',
      ufAmount: '10.5',
      clpAmount: '425702',
    },
    {
      position: 2,
      projectCenterCode: 'CP-TEST-2',
      projectName: 'Proyecto ficticio dos',
      productName: 'Producto ficticio',
      ufAmount: '20.3',
      clpAmount: '823024',
    },
  ],
  receivers: [
    { position: 1, displayName: 'Receptor Uno', email: 'receiver.one@example.invalid' },
    { position: 2, displayName: null, email: 'receiver.two@example.invalid' },
  ],
};

async function open(data: InvoiceWorkbookData) {
  const generated = await new TechnicalInvoiceWorkbookRenderer().generateAndValidate(data);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(generated.bytes).buffer);
  const sheet = workbook.getWorksheet('Solicitud de factura');
  if (!sheet) throw new Error('Hoja esperada ausente');
  return { generated, workbook, sheet };
}

describe('XLSX técnico de solicitud de factura', () => {
  it('valida estructura, STANDARD, múltiples CP, receptores y regresión de un peso', async () => {
    const { generated, workbook, sheet } = await open(base);
    expect(generated.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(generated.templateVersion).toBe('TECHNICAL_V1_UNAPPROVED');
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.worksheets.every((candidate) => candidate.state === 'visible')).toBe(true);
    expect(sheet.getCell('A1').text).toContain('PENDIENTE APROBACIÓN VISUAL');
    expect(sheet.getCell('C4').text).toBe('Emisora Ficticia SpA');
    expect(sheet.getCell('C5').text).toBe('Cliente Ficticio');
    expect(sheet.getCell('B12').text).toBe('Orden de Compra/ Nota de Pedido');
    expect(sheet.getCell('C12').text).toBe('OC-TEST-1');
    expect(sheet.getCell('C13').text).toBe('HES-TEST-1');
    expect(sheet.getCell('B18').text).toBe('RECEPTORES DEL DOCUMENTO');
    expect(sheet.getCell('C18').text).toContain('receiver.one@example.invalid');
    expect(sheet.getCell('C18').text).not.toContain('MAS Consultores o Más Capacitación');
    expect(sheet.getCell('C21').text).toContain('CP-TEST-1');
    expect(sheet.getCell('C22').text).toContain('CP-TEST-2');
    expect(sheet.getCell('E21').formula).toBe('425702');
    expect(sheet.getCell('E22').formula).toBe('823024');
    expect(sheet.getCell('C15').formula).toBe('1248726');
    expect(sheet.getCell('C15').formula).not.toBe('1248727');
    expect(sheet.getCell('C16').formula).toBe('237260');
    expect(sheet.getCell('C17').formula).toBe('1485986');
    expect(sheet.getCell('C20').text).toBe('10/07/2026');
    expect(sheet.getCell('C24').text).toBe('Responsable Ficticio');
    expect(JSON.stringify(workbook.model)).not.toContain('SF-2026-');
  });

  it('aplica HABITAT exactamente en B12/C12 y conserva HES en C13', async () => {
    const { sheet } = await open({ ...base, templateVariant: 'HABITAT' });
    expect(sheet.getCell('B12').text).toBe('OC / N° Contrato');
    expect(sheet.getCell('C12').text).toBe('OC: OC-TEST-1 / Contrato: CONTRATO-TEST-1');
    expect(sheet.getCell('C13').text).toBe('HES-TEST-1');
  });

  it('neutraliza fórmulas aportadas como texto y no genera macros ni vínculos externos', async () => {
    const { generated, sheet } = await open({
      ...base,
      issuerLegalName: '=WEBSERVICE("https://example.invalid")',
      clientShortName: '+CMD',
      description: '@SUM(A1:A2)',
      observations: '-2+3',
      receivers: [{ position: 1, displayName: '=HYPERLINK("x")', email: 'safe@example.invalid' }],
    });
    expect(sheet.getCell('C4').text.startsWith("'=")).toBe(true);
    expect(sheet.getCell('C5').text.startsWith("'+")).toBe(true);
    expect(sheet.getCell('C14').text.startsWith("'@")).toBe(true);
    expect(sheet.getCell('C18').text).toContain("'=HYPERLINK");
    const archive = Buffer.from(generated.bytes).toString('latin1');
    expect(archive).not.toContain('vbaProject.bin');
    expect(archive).not.toContain('externalLinks/');
    expect(archive).not.toContain('connections.xml');
  });
});
