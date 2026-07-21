import { ExactDecimal, clpToString, decimalToString, parseDecimalString } from './decimal.js';

export const INVOICE_CALCULATION_ALGORITHM = 'LEGACY_V1' as const;
export type CalculationTaxTreatment = 'AFFECTED' | 'EXEMPT';

export interface InvoiceCalculationLineInput {
  projectCenterId: string;
  ufAmount: string;
  position: number;
}

export interface InvoiceCalculationInput {
  ufDate: string;
  ufValue: string;
  taxTreatment: CalculationTaxTreatment;
  taxRate?: string;
  lines: readonly InvoiceCalculationLineInput[];
}

export interface CalculatedInvoiceLine {
  projectCenterId: string;
  ufAmount: string;
  ufValue: string;
  clpAmount: string;
  position: number;
}

export interface InvoiceCalculationResult {
  algorithmVersion: typeof INVOICE_CALCULATION_ALGORITHM;
  taxTreatment: CalculationTaxTreatment;
  taxRate: string;
  ufDate: string;
  ufValue: string;
  sumUf: string;
  netClp: string;
  ivaClp: string;
  totalClp: string;
  lines: CalculatedInvoiceLine[];
}

function resolveTaxRate(treatment: CalculationTaxTreatment, supplied?: string) {
  const expected = treatment === 'AFFECTED' ? '0.19' : '0';
  const rate = parseDecimalString(supplied ?? expected, 'taxRate');

  if (treatment === 'EXEMPT' && !rate.isZero()) {
    throw new Error('El tratamiento EXEMPT exige una tasa tributaria 0');
  }
  if (treatment === 'AFFECTED' && !rate.equals(new ExactDecimal('0.19'))) {
    throw new Error('LEGACY_V1 exige una tasa tributaria 0.19 para AFFECTED');
  }
  return rate;
}

/**
 * Motor puro LEGACY_V1. No consulta red, base de datos, folios ni reloj.
 * Cada línea se redondea HALF_UP antes de sumar y el IVA afecto se eleva al
 * siguiente múltiplo de diez con aritmética Decimal.
 */
export function calculateInvoiceAmounts(input: InvoiceCalculationInput): InvoiceCalculationResult {
  if (input.lines.length === 0) throw new Error('Debe existir al menos una línea de cálculo');

  const ufValue = parseDecimalString(input.ufValue, 'ufValue', { positive: true });
  const taxRate = resolveTaxRate(input.taxTreatment, input.taxRate);
  let sumUf = new ExactDecimal('0');
  let netClp = new ExactDecimal('0');

  const lines = input.lines.map((line) => {
    const ufAmount = parseDecimalString(line.ufAmount, 'ufAmount', { positive: true });
    const clpAmount = ufAmount.times(ufValue).toDecimalPlaces(0, ExactDecimal.ROUND_HALF_UP);

    sumUf = sumUf.plus(ufAmount);
    netClp = netClp.plus(clpAmount);

    return {
      projectCenterId: line.projectCenterId,
      ufAmount: line.ufAmount,
      ufValue: decimalToString(ufValue),
      clpAmount: clpToString(clpAmount),
      position: line.position,
    };
  });

  const ivaClp =
    input.taxTreatment === 'EXEMPT'
      ? new ExactDecimal('0')
      : netClp
          .times(taxRate)
          .dividedBy('10')
          .toDecimalPlaces(0, ExactDecimal.ROUND_CEIL)
          .times('10');

  return {
    algorithmVersion: INVOICE_CALCULATION_ALGORITHM,
    taxTreatment: input.taxTreatment,
    taxRate: decimalToString(taxRate),
    ufDate: input.ufDate,
    ufValue: decimalToString(ufValue),
    sumUf: decimalToString(sumUf),
    netClp: clpToString(netClp),
    ivaClp: clpToString(ivaClp),
    totalClp: clpToString(netClp.plus(ivaClp)),
    lines,
  };
}
