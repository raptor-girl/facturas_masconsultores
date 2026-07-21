export class InvalidChileanRutError extends Error {
  constructor() {
    super('El RUT chileno no es válido.');
    this.name = 'InvalidChileanRutError';
  }
}

function cleaned(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[.\-\s]/g, '');
}

export function calculateChileanRutCheckDigit(body: string): string {
  if (!/^\d{7,8}$/.test(body)) throw new InvalidChileanRutError();
  let sum = 0;
  let multiplier = 2;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const result = 11 - (sum % 11);
  if (result === 11) return '0';
  if (result === 10) return 'K';
  return String(result);
}

/** Devuelve la representación canónica de persistencia: cuerpo + DV, sin puntos ni guion. */
export function normalizeChileanRut(value: string): string {
  const normalized = cleaned(value);
  if (!/^\d{7,8}[0-9K]$/.test(normalized)) throw new InvalidChileanRutError();
  const body = normalized.slice(0, -1);
  if (calculateChileanRutCheckDigit(body) !== normalized.at(-1)) {
    throw new InvalidChileanRutError();
  }
  return normalized;
}

export function isValidChileanRut(value: string): boolean {
  try {
    normalizeChileanRut(value);
    return true;
  } catch {
    return false;
  }
}

/** Formato de presentación, nunca usado como clave de unicidad. */
export function formatChileanRut(value: string): string {
  const normalized = normalizeChileanRut(value);
  const body = normalized.slice(0, -1);
  const checkDigit = normalized.at(-1)!;
  const dotted = body.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${dotted}-${checkDigit}`;
}
