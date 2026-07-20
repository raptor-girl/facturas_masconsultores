import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { Decimal } from 'decimal.js';
import { startTestDatabase, connect, type TestDatabase } from '../setup/postgres.js';
import {
  assertNumericParsersUntouched,
  NumericParserViolationError,
  toDecimal,
} from '../../src/infrastructure/postgres/numeric-guard.js';

/**
 * GUARDIA 1 — NUMERIC nunca se convierte a `number` (criterio de término 6).
 *
 * Es la única defensa real contra reintroducir, con otra sintaxis, el problema
 * que `NUMERIC` viene a eliminar. Sin esta prueba, la regla es un comentario.
 */

const NUMERIC_OID = 1700;
const BIGINT_OID = 20;

describe('Guardia: parsers de tipo', () => {
  afterEach(() => {
    // Restaura el default de node-postgres para no contaminar otros tests.
    pg.types.setTypeParser(NUMERIC_OID, (v: string) => v);
    pg.types.setTypeParser(BIGINT_OID, (v: string) => v);
  });

  it('pasa con la configuración por defecto de node-postgres', () => {
    expect(() => {
      assertNumericParsersUntouched();
    }).not.toThrow();
  });

  it('falla si alguien registra un parser que convierte NUMERIC a number', () => {
    // Este es exactamente el cambio "inofensivo" que rompería el sistema:
    // alguien se cansa de manejar strings y lo "arregla".
    pg.types.setTypeParser(NUMERIC_OID, parseFloat);

    expect(() => {
      assertNumericParsersUntouched();
    }).toThrow(NumericParserViolationError);
  });

  it('falla si alguien registra un parser que convierte BIGINT a number', () => {
    pg.types.setTypeParser(BIGINT_OID, Number);

    expect(() => {
      assertNumericParsersUntouched();
    }).toThrow(NumericParserViolationError);
  });
});

describe('Guardia: NUMERIC contra PostgreSQL real', () => {
  let database: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;

  beforeAll(async () => {
    database = await startTestDatabase();
    owner = await connect(database.ownerUri);
    app = await connect(database.appUri);

    // Tabla de sondeo: las tablas con dinero llegan en la Fase 3, pero la regla
    // debe ser exigible desde ahora, antes de que exista el primer peso.
    await owner.query(`
      CREATE TABLE numeric_probe (
        id           INTEGER PRIMARY KEY,
        amount_clp   NUMERIC(18,2) NOT NULL,
        uf_value     NUMERIC(12,4) NOT NULL,
        huge_amount  NUMERIC(30,10) NOT NULL
      )
    `);
    await owner.query(`GRANT SELECT, INSERT ON numeric_probe TO factuflow_app`);
  }, 180_000);

  afterAll(async () => {
    await app.end();
    await owner.end();
    await database.stop();
  });

  it('devuelve NUMERIC como string, no como number', async () => {
    await app.query(
      `INSERT INTO numeric_probe (id, amount_clp, uf_value, huge_amount)
       VALUES (1, '6123455.00', '40543.0700', '12345678901234567890.1234567890')`,
    );

    const { rows } = await app.query<{
      amount_clp: unknown;
      uf_value: unknown;
      huge_amount: unknown;
    }>('SELECT amount_clp, uf_value, huge_amount FROM numeric_probe WHERE id = 1');

    const row = rows[0];
    expect(row).toBeDefined();
    expect(typeof row?.amount_clp).toBe('string');
    expect(typeof row?.uf_value).toBe('string');
    expect(typeof row?.huge_amount).toBe('string');
  });

  it('conserva el valor de la UF exacto — el error real de float4 (C-14)', async () => {
    // El daño de float4 en el legado NO estaba en los montos CLP (un entero
    // hasta 16.777.216 se representa exacto). Estaba aquí: 40543.07 se
    // almacenaba como 40543.0703125, y ese error se MULTIPLICA por el monto.
    const { rows } = await app.query<{ uf_value: string }>(
      'SELECT uf_value FROM numeric_probe WHERE id = 1',
    );

    const ufValue = toDecimal(rows[0]?.uf_value ?? null);
    expect(ufValue?.toFixed(4)).toBe('40543.0700');

    // Demostración del error que se está evitando, no una curiosidad:
    const float4Approximation = Math.fround(40543.07);
    expect(float4Approximation).not.toBe(40543.07);
    expect(new Decimal(float4Approximation).toFixed(7)).toBe('40543.0703125');
  });

  it('un monto grande sobrevive el viaje completo sin perder precisión', async () => {
    const { rows } = await app.query<{ huge_amount: string }>(
      'SELECT huge_amount FROM numeric_probe WHERE id = 1',
    );

    const raw = rows[0]?.huge_amount ?? '';
    const asDecimal = toDecimal(raw);

    expect(asDecimal?.toFixed(10)).toBe('12345678901234567890.1234567890');

    // Y esto es lo que habría pasado con `number`: pérdida silenciosa.
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('el cálculo UF → CLP con Decimal es exacto', async () => {
    const { rows } = await app.query<{ uf_value: string }>(
      'SELECT uf_value FROM numeric_probe WHERE id = 1',
    );

    const ufValue = toDecimal(rows[0]?.uf_value ?? null);
    expect(ufValue).not.toBeNull();

    const ufAmount = new Decimal('150.5');
    const netClp = ufAmount.times(ufValue as Decimal);

    expect(netClp.toFixed(4)).toBe('6101732.0350');

    // ⚠️ El redondeo definitivo NO se aplica aquí: cuántos decimales, si se
    // redondea por CP o sobre el total, y cómo, es una decisión de Finanzas
    // pendiente (D-07). Esta prueba verifica la exactitud de la multiplicación,
    // no la regla de negocio, que todavía no existe.
  });

  it('toDecimal rechaza cualquier cosa que no sea string', () => {
    expect(() => toDecimal(6123455.07 as unknown as string)).toThrow(NumericParserViolationError);
  });
});
