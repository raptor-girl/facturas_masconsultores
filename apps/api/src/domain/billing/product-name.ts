/**
 * Clave de comparación: minúsculas, sin tildes, espacios/puntuación colapsados
 * y plural regular simplificado. Solo rechaza duplicados; nunca fusiona filas.
 */
export function normalizeProductName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-CL')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (word.length > 4 && /[aeiou]s$/.test(word) ? word.slice(0, -1) : word))
    .join(' ');
}
