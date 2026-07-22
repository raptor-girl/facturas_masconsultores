import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TaxTreatment } from '@factuflow/shared-schemas';
import type {
  InvoiceWorkbookData,
  InvoiceWorkbookLine,
  InvoiceWorkbookReceiver,
} from '../application/invoice-requests/invoice-request-service.js';
import { calculateInvoiceAmounts } from '../domain/calculation/invoice-calculation.js';
import { CandidateInvoiceWorkbookRenderer } from '../infrastructure/excel/candidate-invoice-workbook.js';

const UF_DATE = '2026-07-10';
const UF_VALUE = '40543.07';
const reviewDirectory = new URL('../../../../tmp/template-review/', import.meta.url);

interface ReviewLine extends Omit<InvoiceWorkbookLine, 'clpAmount'> {
  readonly projectCenterId: string;
}

interface ReviewOptions {
  readonly templateVariant?: 'STANDARD' | 'HABITAT';
  readonly taxTreatment?: TaxTreatment;
  readonly lines: readonly ReviewLine[];
  readonly receivers: readonly InvoiceWorkbookReceiver[];
  readonly issuerLegalName?: string;
  readonly clientShortName?: string;
  readonly clientLegalName?: string;
  readonly description?: string;
  readonly observations?: string | null;
  readonly coordinatorDisplayName?: string;
}

const lines: readonly ReviewLine[] = [
  {
    projectCenterId: '00000000-0000-4000-8000-000000000101',
    position: 1,
    projectCenterCode: 'CP-FICTICIO-01',
    projectName: 'Proyecto ficticio uno',
    productName: 'Producto ficticio A',
    ufAmount: '10.5',
  },
  {
    projectCenterId: '00000000-0000-4000-8000-000000000102',
    position: 2,
    projectCenterCode: 'CP-FICTICIO-02',
    projectName: 'Proyecto ficticio dos',
    productName: 'Producto ficticio B',
    ufAmount: '20.3',
  },
  {
    projectCenterId: '00000000-0000-4000-8000-000000000103',
    position: 3,
    projectCenterCode: 'CP-FICTICIO-03',
    projectName: 'Proyecto ficticio tres',
    productName: 'Producto ficticio C',
    ufAmount: '1',
  },
];

const receivers: readonly InvoiceWorkbookReceiver[] = [
  { position: 1, displayName: 'Receptor Ficticio Uno', email: 'one@example.invalid' },
  { position: 2, displayName: 'Receptor Ficticio Dos', email: 'two@example.invalid' },
  { position: 3, displayName: null, email: 'three@example.invalid' },
];

function reviewData(options: ReviewOptions): InvoiceWorkbookData {
  const taxTreatment = options.taxTreatment ?? 'AFFECTED';
  const calculation = calculateInvoiceAmounts({
    ufDate: UF_DATE,
    ufValue: UF_VALUE,
    taxTreatment,
    lines: options.lines.map((line) => ({
      projectCenterId: line.projectCenterId,
      ufAmount: line.ufAmount,
      position: line.position,
    })),
  });
  const calculatedByCenter = new Map(
    calculation.lines.map((line) => [line.projectCenterId, line.clpAmount]),
  );

  return {
    templateVariant: options.templateVariant ?? 'STANDARD',
    issuerLegalName: options.issuerLegalName ?? 'Emisora Ficticia SpA',
    clientShortName: options.clientShortName ?? 'Cliente Ficticio',
    clientLegalName: options.clientLegalName ?? 'Cliente Ficticio SpA',
    clientTaxId: '123456785',
    clientBusinessActivity: 'Servicios ficticios de prueba',
    clientAddress: 'Avenida Ficticia 123',
    purchaseOrderNumber: 'OC-FICTICIA-001',
    contractNumber: 'CONTRATO-FICTICIO-001',
    hesNumber: 'HES-FICTICIA-001',
    supplierNumber: 'PROVEEDOR-FICTICIO-001',
    description: options.description ?? 'Servicio mensual ficticio',
    observations: options.observations ?? 'Documento generado solo para revision visual.',
    area: 'Plataformas',
    coordinatorDisplayName: options.coordinatorDisplayName ?? 'Responsable Ficticio',
    period: '2026-07',
    requestDate: '2026-07-10',
    billingDate: '2026-07-15',
    ufDate: UF_DATE,
    ufValue: calculation.ufValue,
    taxTreatment,
    netClp: calculation.netClp,
    ivaClp: calculation.ivaClp,
    totalClp: calculation.totalClp,
    lines: options.lines.map((line) => ({
      position: line.position,
      projectCenterCode: line.projectCenterCode,
      projectName: line.projectName,
      productName: line.productName,
      ufAmount: line.ufAmount,
      clpAmount: calculatedByCenter.get(line.projectCenterId)!,
    })),
    receivers: options.receivers,
  };
}

const cases: readonly (readonly [string, InvoiceWorkbookData])[] = [
  [
    '01-standard-un-cp-un-receptor.xlsx',
    reviewData({ lines: [lines[0]!], receivers: [receivers[0]!] }),
  ],
  ['02-standard-varios-cp-varios-receptores.xlsx', reviewData({ lines, receivers })],
  [
    '03-standard-exento.xlsx',
    reviewData({
      taxTreatment: 'EXEMPT',
      lines: [lines[0]!, lines[1]!],
      receivers: [receivers[0]!],
    }),
  ],
  [
    '04-habitat-oc-contrato-hes.xlsx',
    reviewData({ templateVariant: 'HABITAT', lines: [lines[1]!], receivers: [receivers[1]!] }),
  ],
  [
    '05-afecto-regresion-un-peso.xlsx',
    reviewData({ lines: [lines[0]!, lines[1]!], receivers: [receivers[0]!, receivers[1]!] }),
  ],
  [
    '06-formula-injection-neutralizada.xlsx',
    reviewData({
      lines: [
        {
          ...lines[0]!,
          projectCenterCode: '=DDE',
          projectName: '+Proyecto ficticio',
          productName: '@Producto ficticio',
        },
      ],
      receivers: [{ position: 1, displayName: '=HYPERLINK("x")', email: 'safe@example.invalid' }],
      issuerLegalName: '=WEBSERVICE("https://example.invalid")',
      clientShortName: '+Cliente Ficticio',
      clientLegalName: '@Cliente Ficticio SpA',
      description: '-2+3',
      observations: '=SUM(A1:A2)',
      coordinatorDisplayName: '+Responsable Ficticio',
    }),
  ],
];

async function main(): Promise<void> {
  await mkdir(reviewDirectory, { recursive: true });
  const renderer = new CandidateInvoiceWorkbookRenderer();
  for (const [fileName, data] of cases) {
    const generated = await renderer.generateAndValidate(data);
    const outputUrl = new URL(fileName, reviewDirectory);
    await writeFile(outputUrl, generated.bytes);
    const sha256 = createHash('sha256').update(generated.bytes).digest('hex');
    process.stdout.write(`${fileURLToPath(outputUrl)} | ${sha256}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : 'No se pudieron crear las revisiones.'}\n`,
  );
  process.exitCode = 1;
});
