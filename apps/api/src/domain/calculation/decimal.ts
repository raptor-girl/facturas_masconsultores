import { Decimal } from 'decimal.js';

/**
 * Contexto decimal aislado para dinero y UF. Una precisión amplia evita que
 * operaciones intermedias queden sujetas al valor global de decimal.js.
 */
export const ExactDecimal = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -50,
  toExpPos: 50,
});

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class DecimalInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'DecimalInputError';
  }
}

export function parseDecimalString(
  value: string,
  field: string,
  options: { positive?: boolean } = {},
): InstanceType<typeof ExactDecimal> {
  if (typeof value !== 'string') {
    throw new DecimalInputError(field, 'debe llegar como string, nunca como number');
  }
  if (!DECIMAL_PATTERN.test(value)) {
    throw new DecimalInputError(field, 'debe ser un decimal canónico no negativo');
  }

  const decimal = new ExactDecimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new DecimalInputError(field, 'debe ser un decimal finito no negativo');
  }
  if (options.positive === true && decimal.isZero()) {
    throw new DecimalInputError(field, 'debe ser mayor que cero');
  }
  return decimal;
}

/** Serializa sin notación científica y sin ceros fraccionales artificiales. */
export function decimalToString(value: InstanceType<typeof ExactDecimal>): string {
  return value.toFixed();
}

export function clpToString(value: InstanceType<typeof ExactDecimal>): string {
  if (!value.isInteger() || value.isNegative()) {
    throw new DecimalInputError('CLP', 'debe ser un entero no negativo');
  }
  return value.toFixed(0);
}
