export class InvalidUfDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUfDateError';
  }
}

export function assertValidUfDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new InvalidUfDateError('La fecha UF debe usar YYYY-MM-DD');

  const year = parseInt(match[1] ?? '', 10);
  const month = parseInt(match[2] ?? '', 10);
  const day = parseInt(match[3] ?? '', 10);
  if (year < 1990) throw new InvalidUfDateError('La fecha UF está fuera del rango soportado');
  if (month < 1 || month > 12) throw new InvalidUfDateError('El mes de la fecha UF no es válido');

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (monthDays[month - 1] ?? 0)) {
    throw new InvalidUfDateError('El día de la fecha UF no es válido');
  }
}

export function ufDateParts(value: string): { year: string; month: number; day: number } {
  assertValidUfDate(value);
  const [year = '', month = '', day = ''] = value.split('-');
  return { year, month: parseInt(month, 10), day: parseInt(day, 10) };
}
