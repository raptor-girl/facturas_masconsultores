import {
  INVOICE_CANDIDATE_TEMPLATE_VERSION,
  type ExcelTemplateVariant,
} from '@factuflow/shared-schemas';

export const INVOICE_TEMPLATE_FILE_NAME = 'solicitud-factura-soprole-clone-v1.xlsx' as const;

/**
 * Mapa unico de la plantilla clonada desde el Excel Soprole. El renderer solo
 * escribe en estas celdas existentes; no inserta secciones, columnas ni tablas.
 */
export const INVOICE_TEMPLATE_MAP = {
  sheetName: 'Hoja1',
  titleText: 'SOLICITUD DE FACTURA GRUPO MAS',
  templateVersion: INVOICE_CANDIDATE_TEMPLATE_VERSION,
  printArea: 'B2:I34',
  mainArea: 'B2:D24',
  cells: {
    title: 'B2',
    issuerCompany: 'C4',
    clientShortName: 'C5',
    clientLegalName: 'C8',
    clientTaxId: 'C9',
    clientBusinessActivity: 'C10',
    clientAddress: 'C11',
    purchaseOrder: 'C12',
    hes: 'C13',
    description: 'C14',
    net: 'C15',
    iva: 'C16',
    total: 'C17',
    receivers: 'C18',
    requestDate: 'C20',
    projectCenters: 'C21',
    projectCenterAmounts: 'D21',
    area: 'C22',
    coordinator: 'C23',
    observations: 'C24',
    notesTitle: 'B26',
    notesLine1: 'B27',
    notesLine2: 'B28',
  },
  labels: {
    purchaseOrder: 'B12',
    hes: 'B13',
    iva: 'B16',
  },
  rows: {
    receivers: 18,
    projectCenters: 21,
  },
  baseHeights: {
    receivers: 58.5,
    projectCenters: 19.5,
  },
  variants: {
    STANDARD: {
      purchaseOrderLabel: 'Orden de Compra/ Nota de Pedido',
    },
    HABITAT: {
      purchaseOrderLabel: 'OC / N° Contrato',
    },
  },
} as const;

export interface ResolvedInvoiceTemplateMap {
  readonly sheetName: typeof INVOICE_TEMPLATE_MAP.sheetName;
  readonly templateVersion: typeof INVOICE_TEMPLATE_MAP.templateVersion;
  readonly title: string;
  readonly issuerCompany: string;
  readonly clientShortName: string;
  readonly clientLegalName: string;
  readonly clientTaxId: string;
  readonly clientBusinessActivity: string;
  readonly clientAddress: string;
  readonly purchaseOrder: string;
  readonly hes: string;
  readonly description: string;
  readonly net: string;
  readonly iva: string;
  readonly total: string;
  readonly receivers: string;
  readonly requestDate: string;
  readonly projectCenters: string;
  readonly projectCenterAmounts: string;
  readonly area: string;
  readonly coordinator: string;
  readonly observations: string;
  readonly printArea: string;
}

export function resolveInvoiceTemplateMap(
  _variant: ExcelTemplateVariant,
): ResolvedInvoiceTemplateMap {
  return {
    sheetName: INVOICE_TEMPLATE_MAP.sheetName,
    templateVersion: INVOICE_TEMPLATE_MAP.templateVersion,
    title: INVOICE_TEMPLATE_MAP.cells.title,
    issuerCompany: INVOICE_TEMPLATE_MAP.cells.issuerCompany,
    clientShortName: INVOICE_TEMPLATE_MAP.cells.clientShortName,
    clientLegalName: INVOICE_TEMPLATE_MAP.cells.clientLegalName,
    clientTaxId: INVOICE_TEMPLATE_MAP.cells.clientTaxId,
    clientBusinessActivity: INVOICE_TEMPLATE_MAP.cells.clientBusinessActivity,
    clientAddress: INVOICE_TEMPLATE_MAP.cells.clientAddress,
    purchaseOrder: INVOICE_TEMPLATE_MAP.cells.purchaseOrder,
    hes: INVOICE_TEMPLATE_MAP.cells.hes,
    description: INVOICE_TEMPLATE_MAP.cells.description,
    net: INVOICE_TEMPLATE_MAP.cells.net,
    iva: INVOICE_TEMPLATE_MAP.cells.iva,
    total: INVOICE_TEMPLATE_MAP.cells.total,
    receivers: INVOICE_TEMPLATE_MAP.cells.receivers,
    requestDate: INVOICE_TEMPLATE_MAP.cells.requestDate,
    projectCenters: INVOICE_TEMPLATE_MAP.cells.projectCenters,
    projectCenterAmounts: INVOICE_TEMPLATE_MAP.cells.projectCenterAmounts,
    area: INVOICE_TEMPLATE_MAP.cells.area,
    coordinator: INVOICE_TEMPLATE_MAP.cells.coordinator,
    observations: INVOICE_TEMPLATE_MAP.cells.observations,
    printArea: INVOICE_TEMPLATE_MAP.printArea,
  };
}
