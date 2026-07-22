import ExcelJS from '@excel.js/exceljs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { InvoiceWorkbookData } from '../../src/application/invoice-requests/invoice-request-service.js';
import { CandidateInvoiceWorkbookRenderer } from '../../src/infrastructure/excel/candidate-invoice-workbook.js';
import { TEMPLATE_MAIN_FONT } from '../../src/infrastructure/excel/invoice-template-layout.js';
import {
  INVOICE_TEMPLATE_FILE_NAME,
  INVOICE_TEMPLATE_MAP,
  resolveInvoiceTemplateMap,
} from '../../src/infrastructure/excel/invoice-template-map.js';
import {
  listFormulaCells,
  listXlsxEntries,
  readExactNumericCell,
  readFormulaCell,
  readXlsxEntry,
} from '../../src/infrastructure/excel/xlsx-archive.js';

const candidateTemplateUrl = new URL(
  `../../../../templates/approved/${INVOICE_TEMPLATE_FILE_NAME}`,
  import.meta.url,
);

const hiddenTechnicalTexts = [
  'Fecha de Facturación',
  'Período',
  'Fecha UF',
  'Valor UF',
  'N° de Proveedor',
  'Cantidad UF',
  'Tipo de CP',
  'CENTROS DE PROYECTO',
  'RECEPTORES DEL DOCUMENTO',
] as const;

const expectedNotes = [
  'NOTAS: ',
  '*Si la solicitud es exenta de IVA, solo completar el monto total.',
  '*Si la factura es con IVA, solo debes agregar el monto neto y automáticamente ',
  '  dará el valor de IVA y bruto.',
  '*Para efecto de las proyecciones del 2023, deberá agregarse una columna al lado ',
  '  de cada CP, indicando si el proyecto está afecto, exento de IVA o mixto.',
  '*En las proyecciones debe incluirse el valor total de proyecto, incluyendo el IVA, ',
  '  si este está afecto a IVA, ya que ese es el valor que se facturará y corresponderá a la ',
  '  caja que se percibirá por el cobro de esa factura.',
] as const;

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
  observations: 'Observacion ficticia',
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
  const generated = await new CandidateInvoiceWorkbookRenderer().generateAndValidate(data);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(generated.bytes).buffer);
  const sheet = workbook.getWorksheet(INVOICE_TEMPLATE_MAP.sheetName);
  if (!sheet) throw new Error('Hoja esperada ausente');
  return { generated, workbook, sheet };
}

async function xlsxText(bytes: Uint8Array): Promise<string> {
  return `${(await readXlsxEntry(bytes, 'xl/sharedStrings.xml')) ?? ''}\n${
    (await readXlsxEntry(bytes, 'xl/worksheets/sheet1.xml')) ?? ''
  }`;
}

function expectNoTechnicalFields(text: string): void {
  for (const value of hiddenTechnicalTexts) expect(text).not.toContain(value);
}

function expectNoVisibleAccidental41(sheet: ExcelJS.Worksheet): void {
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.value !== null && cell.value !== undefined) expect(cell.text).not.toBe('41');
    });
  });
}

describe('plantilla candidata clonada', () => {
  it('usa la plantilla xlsx clonada desde el Excel Soprole, sin reconstruccion manual visible', async () => {
    const bytes = await readFile(candidateTemplateUrl);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    const sheet = workbook.getWorksheet(INVOICE_TEMPLATE_MAP.sheetName);
    expect(sheet).toBeTruthy();
    if (!sheet) throw new Error('Plantilla candidata sin hoja');

    expect(INVOICE_TEMPLATE_FILE_NAME).toBe('solicitud-factura-soprole-clone-v1.xlsx');
    expect(workbook.worksheets).toHaveLength(1);
    expect(sheet.name).toBe('Hoja1');
    expect(sheet.state).toBe('visible');
    expect(sheet.getCell('B2').text).toBe('SOLICITUD DE FACTURA GRUPO MAS');
    expect(sheet.getCell('B7').text).toBe('INFORMACIÓN CLIENTE');
    expect(sheet.getCell('B18').text).toBe('Receptor de Documento');
    expect(sheet.getCell('B19').text).toBe('Información Interna');
    expect(sheet.getCell('B21').text).toBe('Centro de Proyecto');
    expect(sheet.getCell('B22').text).toBe('Área');
    for (const [index, noteLine] of expectedNotes.entries()) {
      expect(sheet.getCell(`B${26 + index}`).text).toBe(noteLine);
    }
    expect(sheet.getCell('C4').text).toBe('');
    expect(sheet.getCell('C15').text).toBe('');
    expect(sheet.getCell('C18').text).toBe('');

    expect(sheet.getCell('B7').font.name).toBe(TEMPLATE_MAIN_FONT);
    expect(sheet.getCell('B7').font.size).toBe(11);
    expect(sheet.getCell('B7').fill).toMatchObject({
      type: 'pattern',
      fgColor: { theme: 9 },
    });
    expect(sheet.getCell('B7').border.top?.style).toBe('medium');
    expect(sheet.getCell('B4').font.bold).toBe(true);
    expect(sheet.getCell('B8').font.bold).not.toBe(true);
    expect(sheet.getCell('B17').font.bold).toBe(true);
    expect(sheet.getCell('B18').fill).not.toMatchObject({
      pattern: 'solid',
      fgColor: { theme: 9 },
    });
    expect(sheet.getColumn('B').width).toBeCloseTo(32.45, 2);
    expect(sheet.getColumn('C').width).toBeCloseTo(18.54, 2);
    expect(sheet.getColumn('D').width).toBeCloseTo(24.36, 2);
    expect(sheet.getRow(4).height).toBe(19.5);
    expect(sheet.getRow(13).height).toBe(44.25);
    expect(sheet.getRow(14).height).toBe(29.5);
    expect(sheet.getRow(18).height).toBe(58.5);
    expect(sheet.getRow(23).height).toBe(54);
    expect(sheet.getRow(24).height).toBe(29.5);

    expect(sheet.model.merges).toEqual(
      expect.arrayContaining([
        'B2:C2',
        'C4:D4',
        'C5:D5',
        'B6:D6',
        'B7:D7',
        'C8:D8',
        'C15:D15',
        'C18:D18',
        'B19:D19',
        'C20:D20',
        'C22:D22',
        'C23:D23',
        'C24:D24',
      ]),
    );
    expect(sheet.model.merges).not.toContain('C21:D21');
    expect(sheet.pageSetup.orientation).toBe('portrait');
    expect(sheet.pageSetup.scale).toBe(100);
    expect(sheet.pageSetup.fitToWidth).toBe(1);
    expect(sheet.pageSetup.fitToHeight).toBe(1);
    expect(sheet.views[0]?.showGridLines).toBe(false);
    expect(sheet.pageSetup.printArea).toBe(INVOICE_TEMPLATE_MAP.printArea);
    expectNoVisibleAccidental41(sheet);

    expect(workbook.creator ?? '').not.toContain('Soprole');
    expect(workbook.lastModifiedBy ?? '').not.toContain('Soprole');
    expect(createHash('sha256').update(bytes).digest('hex')).toMatch(/^[0-9a-f]{64}$/);

    const worksheetXml = await readXlsxEntry(bytes, 'xl/worksheets/sheet1.xml');
    const entries = await listXlsxEntries(bytes);
    expect(worksheetXml).not.toMatch(/<f(?:\s|>)/);
    expect(worksheetXml).not.toContain('ROUNDUP');
    expect(entries.some((entry) => entry.includes('vbaProject.bin'))).toBe(false);
    expect(entries.some((entry) => entry.includes('externalLinks/'))).toBe(false);
    expect(entries.some((entry) => entry.includes('connections.xml'))).toBe(false);
    expect(entries.some((entry) => entry.includes('embeddings/'))).toBe(false);
    expectNoTechnicalFields(await xlsxText(bytes));
  });
});

describe('renderer candidato productivo', () => {
  it('genera STANDARD sobre celdas existentes, con receptores y CP/MS multilínea', async () => {
    const { generated, workbook, sheet } = await open(base);
    const map = resolveInvoiceTemplateMap('STANDARD');

    expect(generated.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(generated.templateVersion).toBe('SOLICITUD_FACTURA_CLONE_CANDIDATE_V1');
    expect(workbook.worksheets).toHaveLength(1);
    expect(sheet.getCell('C4').text).toBe('MAS CONSULTORES S.A.');
    expect(sheet.getCell('C4').text).not.toBe('Emisora Ficticia SpA');
    expect(sheet.getCell('C5').text).toBe('Cliente Ficticio');
    expect(sheet.getCell('B12').text).toBe('Orden de Compra/ Nota de Pedido');
    expect(sheet.getCell('C12').text).toBe('OC-TEST-1');
    expect(sheet.getCell('C12').text).not.toContain('Contrato');
    expect(sheet.getCell('C13').text).toBe('HES-TEST-1');
    expect(sheet.getCell(map.requestDate).text).toBe('10/07/2026');
    expect(sheet.getCell(map.area).text).toBe('MAS Plataformas');
    expect(sheet.getCell(map.area).text).not.toBe('Plataformas');
    for (const [index, noteLine] of expectedNotes.entries()) {
      expect(sheet.getCell(`B${26 + index}`).text).toBe(noteLine);
    }
    expect(sheet.getCell(map.receivers).text).toBe(
      'Receptor Uno - receiver.one@example.invalid\nreceiver.two@example.invalid',
    );
    expect(sheet.getCell(map.projectCenters).text).toBe('CP-TEST-1\nCP-TEST-2');
    expect(sheet.getCell(map.projectCenterAmounts).text).toBe('$425.702\n$823.024');
    expect(sheet.getRow(18).height).toBeGreaterThan(58.5);
    expect(sheet.getRow(21).height).toBeGreaterThan(19.5);
    expect(sheet.pageSetup.printArea).toBe(INVOICE_TEMPLATE_MAP.printArea);

    expect(await readExactNumericCell(generated.bytes, map.net)).toBe('1248726');
    expect(await readExactNumericCell(generated.bytes, map.net)).not.toBe('1248727');
    const ivaFormula = await readFormulaCell(generated.bytes, map.iva);
    const totalFormula = await readFormulaCell(generated.bytes, map.total);
    expect(ivaFormula).toEqual({
      address: map.iva,
      formula: 'ROUNDUP((C15*19%),0)',
      cachedValue: '237260',
    });
    expect(totalFormula).toEqual({
      address: map.total,
      formula: 'C15+C16',
      cachedValue: '1485986',
    });
    expect(await listFormulaCells(generated.bytes)).toEqual([ivaFormula, totalFormula]);
    expect(await readXlsxEntry(generated.bytes, 'xl/sharedStrings.xml')).not.toContain(
      '__FACTUFLOW_EXACT_',
    );
    expectNoTechnicalFields(await xlsxText(generated.bytes));
    expect(JSON.stringify(workbook.model)).not.toContain('SF-2026-');
  });

  it('aplica HABITAT solo por variante, sin fila extra ni valor accidental 41', async () => {
    const habitat = { ...base, templateVariant: 'HABITAT' as const };
    const { sheet } = await open(habitat);
    expect(sheet.getCell('B12').text).toBe('OC / N° Contrato');
    expect(sheet.getCell('C12').text).toBe('OC: OC-TEST-1 / Contrato: CONTRATO-TEST-1');
    expect(sheet.getCell('B13').text).toBe('HES');
    expect(sheet.getCell('C13').text).toBe('HES-TEST-1');
    expect(sheet.getCell('B22').text).toBe('Área');
    expect(sheet.getCell('C22').text).toBe('MAS Plataformas');
    expect(sheet.getCell('C22').text).not.toBe('Plataformas');
    expectNoVisibleAccidental41(sheet);
  });

  it('escribe exento sin formula y conserva el monto de un CP en D21', async () => {
    const exempt: InvoiceWorkbookData = {
      ...base,
      taxTreatment: 'EXEMPT',
      netClp: '425702',
      ivaClp: '0',
      totalClp: '425702',
      lines: [base.lines[0]!],
      receivers: [base.receivers[0]!],
    };
    const { generated, sheet } = await open(exempt);
    const map = resolveInvoiceTemplateMap('STANDARD');
    expect(sheet.getCell(map.net).text).toBe('');
    expect(sheet.getCell(map.iva).text).toBe('');
    expect(await readExactNumericCell(generated.bytes, map.iva)).toBeNull();
    expect(await readExactNumericCell(generated.bytes, map.total)).toBe('425702');
    expect(await readExactNumericCell(generated.bytes, map.projectCenterAmounts)).toBe('425702');
    expect(await listFormulaCells(generated.bytes)).toEqual([]);
    expect(sheet.getCell(map.receivers).text).toContain('receiver.one@example.invalid');
    expect(sheet.getCell(map.projectCenters).text).toBe('CP-TEST-1');
    expect(sheet.pageSetup.printArea).toBe('B2:I34');
  });

  it('neutraliza formula injection sin apostrofe visible ni formulas XML', async () => {
    const { generated, sheet } = await open({
      ...base,
      issuerLegalName: '=WEBSERVICE("https://example.invalid")',
      clientShortName: '+CMD',
      description: '@SUM(A1:A2)',
      observations: '-2+3',
      coordinatorDisplayName: '=HYPERLINK("x")',
      lines: [
        {
          ...base.lines[0]!,
          projectCenterCode: '=DDE',
          projectName: '+Proyecto',
          productName: '@Producto',
        },
      ],
      receivers: [{ position: 1, displayName: '=HYPERLINK("x")', email: 'safe@example.invalid' }],
    });
    const map = resolveInvoiceTemplateMap('STANDARD');
    expect(sheet.getCell('C4').text).toBe('MAS CONSULTORES S.A.');
    expect(sheet.getCell('C5').text).toBe('+CMD');
    expect(sheet.getCell('C14').text).toBe('@SUM(A1:A2)');
    expect(sheet.getCell(map.observations).text).toBe('-2+3');
    expect(sheet.getCell(map.receivers).text).toContain('=HYPERLINK("x")');
    expect(sheet.getCell(map.receivers).text).not.toContain("'=");
    expect(sheet.getCell(map.projectCenters).text).toBe('=DDE');
    expect(sheet.getCell(map.projectCenters).text).not.toContain("'=");
    const entries = await listXlsxEntries(generated.bytes);
    const worksheetXml = await readXlsxEntry(generated.bytes, 'xl/worksheets/sheet1.xml');
    const rels = await readXlsxEntry(generated.bytes, 'xl/_rels/workbook.xml.rels');
    expect(await listFormulaCells(generated.bytes)).toEqual([
      { address: map.iva, formula: 'ROUNDUP((C15*19%),0)', cachedValue: '237260' },
      { address: map.total, formula: 'C15+C16', cachedValue: '1485986' },
    ]);
    expect(worksheetXml).not.toContain('WEBSERVICE');
    expect(worksheetXml).not.toContain('HYPERLINK');
    expect(worksheetXml).not.toContain('DDE');
    expect(rels).not.toMatch(/TargetMode="External"/i);
    expect(entries.some((entry) => /vba|externalLinks|connections|embeddings/i.test(entry))).toBe(
      false,
    );
  });
});
