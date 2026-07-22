/** Serialización estable para la huella de idempotencia. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new Error('El payload canónico sólo admite enteros seguros.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('El payload canónico contiene un valor no serializable.');
}

/** En XLSX se escribe como cadena compartida; solo el renderer puede crear formulas controladas. */
export function sanitizeSpreadsheetText(value: string): string {
  return value;
}

/** Parte de filename ASCII, sin rutas, controles ni caracteres de cabecera. */
export function safeFilenamePart(value: string, fallback = 'CLIENTE'): string {
  const clean = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return clean || fallback;
}
