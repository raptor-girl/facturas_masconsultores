/**
 * Formato del folio: SF-AAAA-00001
 *
 * Dominio puro: sin PostgreSQL, sin HTTP, sin frameworks. Se prueba sin
 * levantar nada. El lint hace fallar el CI si alguien importa aquí `pg`,
 * `kysely` o `fastify` (ver eslint.config.js).
 *
 * La RESERVA del correlativo no vive aquí: es transaccional y por lo tanto
 * es infraestructura (función reserve_folio en PostgreSQL). Aquí solo vive la
 * forma del folio, que es una regla de negocio.
 */

const FOLIO_PATTERN = /^SF-(\d{4})-(\d{5})$/;
const CORRELATIVE_LENGTH = 5;
const MAX_CORRELATIVE = 99_999;

export class InvalidFolioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFolioError';
  }
}

export interface FolioParts {
  readonly year: number;
  readonly correlative: number;
}

export function formatFolio({ year, correlative }: FolioParts): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2999) {
    throw new InvalidFolioError(`Año de folio fuera de rango: ${year}`);
  }
  if (!Number.isInteger(correlative) || correlative < 1 || correlative > MAX_CORRELATIVE) {
    throw new InvalidFolioError(
      `Correlativo fuera de rango: ${correlative}. Válido: 1..${MAX_CORRELATIVE}.`,
    );
  }

  return `SF-${String(year)}-${String(correlative).padStart(CORRELATIVE_LENGTH, '0')}`;
}

export function parseFolio(folio: string): FolioParts {
  const match = FOLIO_PATTERN.exec(folio);
  if (!match) {
    throw new InvalidFolioError(`Folio con formato inválido: '${folio}'. Esperado SF-AAAA-00001.`);
  }

  // El patrón garantiza ambos grupos; noUncheckedIndexedAccess obliga a probarlo.
  const [, rawYear, rawCorrelative] = match;
  if (rawYear === undefined || rawCorrelative === undefined) {
    throw new InvalidFolioError(`Folio con formato inválido: '${folio}'.`);
  }

  return { year: Number(rawYear), correlative: Number(rawCorrelative) };
}

export function isValidFolio(folio: string): boolean {
  return FOLIO_PATTERN.test(folio);
}
