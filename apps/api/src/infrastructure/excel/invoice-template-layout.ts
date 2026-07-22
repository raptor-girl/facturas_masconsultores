import type ExcelJS from '@excel.js/exceljs';
import { INVOICE_TEMPLATE_MAP } from './invoice-template-map.js';

export const TEMPLATE_MAIN_FONT = 'Calibri' as const;
export const TEMPLATE_CLP_FORMAT = '"$"#,##0;[Red]"$"-#,##0' as const;
export const TEMPLATE_FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');

export function applyNeutralWorkbookProperties(workbook: ExcelJS.Workbook): void {
  workbook.creator = 'FactuFlow';
  workbook.lastModifiedBy = 'FactuFlow';
  workbook.created = TEMPLATE_FIXED_DATE;
  workbook.modified = TEMPLATE_FIXED_DATE;
  workbook.company = 'FactuFlow';
  workbook.title = 'Solicitud de Factura';
  workbook.subject = INVOICE_TEMPLATE_MAP.templateVersion;
  workbook.description =
    'Plantilla candidata clonada desde la solicitud de factura Soprole y sanitizada por FactuFlow.';
}
