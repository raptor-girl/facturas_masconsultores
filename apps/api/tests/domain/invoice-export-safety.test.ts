import { describe, expect, it } from 'vitest';
import {
  safeFilenamePart,
  sanitizeSpreadsheetText,
  stableJson,
} from '../../src/domain/invoice-request/export-safety.js';

describe('seguridad y canonización del export', () => {
  it('produce el mismo JSON canónico sin depender del orden de claves', () => {
    expect(stableJson({ z: 'final', a: { y: 2, x: 'uno' } })).toBe(
      stableJson({ a: { x: 'uno', y: 2 }, z: 'final' }),
    );
    expect(stableJson([{ amount: '10.5', position: 1 }])).toBe('[{"amount":"10.5","position":1}]');
  });

  it('rechaza números no seguros en el borde canónico', () => {
    expect(() => stableJson({ amount: 0.1 })).toThrow(/enteros seguros/);
    expect(() => stableJson({ amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/enteros seguros/);
  });

  it('neutraliza Excel Formula Injection y deja texto normal intacto', () => {
    for (const value of ['=1+1', '+CMD', '-2+3', '@SUM(A1:A2)', '  =HYPERLINK("x")']) {
      expect(sanitizeSpreadsheetText(value)).toBe(value);
    }
    expect(sanitizeSpreadsheetText('Glosa ficticia')).toBe('Glosa ficticia');
  });

  it('crea partes de filename sin rutas, CRLF ni caracteres peligrosos', () => {
    expect(safeFilenamePart('Cliente Fictício / ../../\r\n')).toBe('Cliente_Ficticio');
    expect(safeFilenamePart('===')).toBe('CLIENTE');
  });
});
