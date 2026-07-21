import { describe, expect, it } from 'vitest';
import { normalizeProductName } from '../../src/domain/billing/product-name.js';

describe('nombre canónico de producto', () => {
  it('iguala mayúsculas, tildes, espacios, separadores y plurales regulares', () => {
    expect(normalizeProductName('  TÁLENTOS  ')).toBe(normalizeProductName('talento'));
    expect(normalizeProductName('Clima / Encuesta')).toBe('clima encuesta');
  });
});
