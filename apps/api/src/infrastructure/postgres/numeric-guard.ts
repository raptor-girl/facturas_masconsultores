import pg from 'pg';
import { Decimal } from 'decimal.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * La regla no negociable de todo el stack (R-02 / R-08).
 *
 * `NUMERIC` en PostgreSQL no sirve de nada si el driver lo entrega como
 * `float64`. Sería reintroducir el problema del sistema anterior con otra
 * sintaxis, y encima creyendo que está resuelto.
 *
 * `node-postgres` devuelve NUMERIC (OID 1700) y BIGINT (OID 20) como `string`
 * por defecto — justamente porque no caben en un `number` sin perder
 * precisión. El riesgo no es el default: es que alguien, en algún momento,
 * escriba `pg.types.setTypeParser(1700, parseFloat)` para "arreglar" un tipo
 * incómodo. Este módulo existe para que eso falle en el arranque, no en una
 * factura.
 *
 * Contexto de por qué importa (C-14, corregido): el daño real de `float4` en
 * el legado no estaba en los montos CLP — un entero hasta 16.777.216 se
 * representa exacto. Estaba en el VALOR DE LA UF (40.543,07 se almacena como
 * 40.543,0703125), cuyo error se multiplica por el monto en UF. Un `number`
 * de JavaScript es float64: aguanta más, pero el mecanismo del error es el
 * mismo, y con dinero no se apuesta a que "seguramente alcanza".
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** OIDs de PostgreSQL cuyos valores JAMÁS deben convertirse a `number`. */
const PROTECTED_OIDS = {
  NUMERIC: 1700,
  BIGINT: 20,
  MONEY: 790,
} as const;

export class NumericParserViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumericParserViolationError';
  }
}

/**
 * Verifica que nadie haya registrado un parser que convierta a `number`.
 *
 * Se llama al construir la conexión: si alguien rompió la regla, la aplicación
 * no arranca. Es deliberado — un arranque fallido es barato; una factura mal
 * calculada, no.
 */
export function assertNumericParsersUntouched(): void {
  // `pg-types` publica getTypeParser como `any`; tipamos explícitamente este
  // borde para impedir que ese `any` se propague al código de la aplicación.
  const getTextParser = pg.types.getTypeParser as unknown as (
    oid: number,
  ) => (value: string) => unknown;

  for (const [name, oid] of Object.entries(PROTECTED_OIDS)) {
    // getTypeParser(oid) devuelve el parser del formato 'text', que es el que
    // usa node-postgres por defecto. La sobrecarga con segundo argumento espera
    // 'text' | 'binary', no un OID.
    const parser = getTextParser(oid);
    const probe: unknown = parser('6123455.07');

    if (typeof probe !== 'string') {
      throw new NumericParserViolationError(
        `Se registró un type parser para ${name} (OID ${oid}) que devuelve ` +
          `${typeof probe} en vez de string. Esto convierte dinero y UF en float64 ` +
          `y reintroduce exactamente el error de precisión que NUMERIC viene a ` +
          `eliminar. Elimina la llamada a pg.types.setTypeParser(${oid}, ...) y ` +
          `convierte con Decimal en el borde del dominio. Ver R-02/R-08.`,
      );
    }

    if (probe !== '6123455.07') {
      throw new NumericParserViolationError(
        `El type parser de ${name} (OID ${oid}) alteró el valor: '6123455.07' → ` +
          `'${probe}'. Debe devolver el texto tal cual lo entrega PostgreSQL.`,
      );
    }
  }
}

/**
 * Único punto autorizado para convertir un valor de la base a un decimal.
 *
 * Recibe el `string` que entrega node-postgres y devuelve un `Decimal`. No
 * existe ninguna ruta legítima que pase por `Number`.
 */
export function toDecimal(value: string | null): Decimal | null {
  if (value === null) return null;

  if (typeof value !== 'string') {
    throw new NumericParserViolationError(
      `Se esperaba string desde PostgreSQL y llegó ${typeof value}. ` +
        `Algún parser está convirtiendo NUMERIC antes de tiempo. Ver R-02/R-08.`,
    );
  }

  return new Decimal(value);
}

/** Convierte un Decimal al `string` que PostgreSQL espera para NUMERIC. */
export function fromDecimal(value: Decimal): string {
  return value.toFixed();
}

export { Decimal };
