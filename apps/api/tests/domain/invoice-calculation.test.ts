import { describe, expect, it } from 'vitest';
import { calculateInvoiceAmounts } from '../../src/domain/calculation/invoice-calculation.js';
import { ExactDecimal, parseDecimalString } from '../../src/domain/calculation/decimal.js';

const line = (projectCenterId: string, ufAmount: string, position: number) => ({
  projectCenterId,
  ufAmount,
  position,
});

describe('Decimal y cálculo tributario LEGACY_V1', () => {
  it('multiplica, suma y serializa con exactitud sin aceptar number', () => {
    const a = parseDecimalString('0.1', 'a');
    const b = parseDecimalString('0.2', 'b');
    expect(a.plus(b).toFixed()).toBe('0.3');
    expect(new ExactDecimal('999999999999.123456').times('3').toFixed()).toBe(
      '2999999999997.370368',
    );
    expect(parseDecimalString('0', 'zero').toFixed()).toBe('0');
    expect(() => parseDecimalString(0.19 as unknown as string, 'rate')).toThrow(/string/);
  });

  it.each([
    ['menos de 0.5', '0.49', '1', '0'],
    ['exactamente 0.5', '0.5', '1', '1'],
    ['más de 0.5', '0.51', '1', '1'],
  ])('redondea HALF_UP por CP: %s', (_name, ufAmount, ufValue, expected) => {
    const result = calculateInvoiceAmounts({
      ufDate: '2024-01-01',
      ufValue,
      taxTreatment: 'EXEMPT',
      lines: [line('00000000-0000-4000-8000-000000000001', ufAmount, 1)],
    });
    expect(result.lines[0]?.clpAmount).toBe(expected);
  });

  it('reproduce R01: redondeo individual e IVA hacia el siguiente múltiplo de 10', () => {
    const result = calculateInvoiceAmounts({
      ufDate: '2024-01-01',
      ufValue: '40543.07',
      taxTreatment: 'AFFECTED',
      lines: [line('00000000-0000-4000-8000-000000000001', '150.5', 1)],
    });
    expect(result).toMatchObject({
      algorithmVersion: 'LEGACY_V1',
      taxRate: '0.19',
      sumUf: '150.5',
      netClp: '6101732',
      ivaClp: '1159330',
      totalClp: '7261062',
    });
  });

  it('reproduce R02: sumar CP redondeados difiere de redondear la suma UF', () => {
    const result = calculateInvoiceAmounts({
      ufDate: '2024-01-01',
      ufValue: '40543.07',
      taxTreatment: 'EXEMPT',
      lines: [
        line('00000000-0000-4000-8000-000000000001', '10.5', 1),
        line('00000000-0000-4000-8000-000000000002', '20.3', 2),
      ],
    });
    expect(result.lines.map((item) => item.clpAmount)).toEqual(['425702', '823024']);
    expect(result.netClp).toBe('1248726');
    const aggregateRounded = new ExactDecimal('30.8')
      .times('40543.07')
      .toDecimalPlaces(0, ExactDecimal.ROUND_HALF_UP)
      .toFixed(0);
    expect(aggregateRounded).toBe('1248727');
    expect(result.netClp).not.toBe(aggregateRounded);
  });

  it.each([
    ['1000', '190'],
    ['1001', '200'],
    ['1053', '210'],
  ])('eleva IVA de neto %s al múltiplo de diez: %s', (netEquivalent, expected) => {
    const result = calculateInvoiceAmounts({
      ufDate: '2024-01-01',
      ufValue: netEquivalent,
      taxTreatment: 'AFFECTED',
      lines: [line('00000000-0000-4000-8000-000000000001', '1', 1)],
    });
    expect(result.ivaClp).toBe(expected);
  });

  it('aplica exención y soporta el caso grande de regresión sin pérdida', () => {
    const result = calculateInvoiceAmounts({
      ufDate: '2024-01-01',
      ufValue: '40543.07',
      taxTreatment: 'EXEMPT',
      taxRate: '0',
      lines: [line('00000000-0000-4000-8000-000000000001', '50000', 1)],
    });
    expect(result.netClp).toBe('2027153500');
    expect(result.ivaClp).toBe('0');
    expect(result.totalClp).toBe('2027153500');
  });

  it('rechaza tasas incompatibles y valores binarios en bordes críticos', () => {
    expect(() =>
      calculateInvoiceAmounts({
        ufDate: '2024-01-01',
        ufValue: '40543.07',
        taxTreatment: 'AFFECTED',
        taxRate: '0.2',
        lines: [line('00000000-0000-4000-8000-000000000001', '1', 1)],
      }),
    ).toThrow(/0.19/);
    expect(() =>
      calculateInvoiceAmounts({
        ufDate: '2024-01-01',
        ufValue: 40543.07 as unknown as string,
        taxTreatment: 'AFFECTED',
        lines: [line('00000000-0000-4000-8000-000000000001', '1', 1)],
      }),
    ).toThrow(/string/);
  });
});
