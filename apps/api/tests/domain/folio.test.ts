import { describe, it, expect } from 'vitest';
import {
  formatFolio,
  parseFolio,
  isValidFolio,
  InvalidFolioError,
} from '../../src/domain/folio/folio.js';

/**
 * Dominio puro: sin base de datos, sin HTTP, sin contenedores.
 * Corre en milisegundos. Asi debe ser toda regla de negocio.
 */
describe('Folio', () => {
  it('formatea con relleno a 5 digitos', () => {
    expect(formatFolio({ year: 2026, correlative: 1 })).toBe('SF-2026-00001');
    expect(formatFolio({ year: 2026, correlative: 81 })).toBe('SF-2026-00081');
    expect(formatFolio({ year: 2026, correlative: 99999 })).toBe('SF-2026-99999');
  });

  it('hace ida y vuelta sin perder informacion', () => {
    const parts = { year: 2026, correlative: 42 };
    expect(parseFolio(formatFolio(parts))).toEqual(parts);
  });

  it('rechaza correlativos fuera de rango', () => {
    expect(() => formatFolio({ year: 2026, correlative: 0 })).toThrow(InvalidFolioError);
    expect(() => formatFolio({ year: 2026, correlative: 100000 })).toThrow(InvalidFolioError);
  });

  it('rechaza anios imposibles', () => {
    expect(() => formatFolio({ year: 1999, correlative: 1 })).toThrow(InvalidFolioError);
  });

  it('rechaza folios mal formados', () => {
    for (const bad of ['SF-2026-1', 'SF-26-00001', 'XX-2026-00001', '', 'SF-2026-000001']) {
      expect(isValidFolio(bad)).toBe(false);
      expect(() => parseFolio(bad)).toThrow(InvalidFolioError);
    }
  });

  it('reconoce el formato legado tal como aparece en el master', () => {
    // SF-2026-00080 es el folio maximo de 2026 segun la documentacion (sin
    // verificar: bdmaster.sql no fue entregado, D-00). El formato es el mismo.
    expect(isValidFolio('SF-2026-00080')).toBe(true);
    expect(parseFolio('SF-2026-00080')).toEqual({ year: 2026, correlative: 80 });
  });
});
