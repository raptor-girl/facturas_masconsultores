import { describe, expect, it } from 'vitest';
import {
  calculateChileanRutCheckDigit,
  formatChileanRut,
  isValidChileanRut,
  normalizeChileanRut,
} from '../../src/domain/billing/chilean-rut.js';

describe('RUT chileno', () => {
  it('normaliza, valida DV y formatea para presentación', () => {
    expect(normalizeChileanRut('12.345.678-5')).toBe('123456785');
    expect(normalizeChileanRut(' 12 345 678 5 ')).toBe('123456785');
    expect(formatChileanRut('123456785')).toBe('12.345.678-5');
    expect(calculateChileanRutCheckDigit('12345678')).toBe('5');
  });

  it('rechaza DV inválido y formatos incompletos', () => {
    expect(isValidChileanRut('12.345.678-4')).toBe(false);
    expect(isValidChileanRut('1234')).toBe(false);
    expect(() => normalizeChileanRut('12.345.678-4')).toThrow(/no es válido/i);
  });
});
