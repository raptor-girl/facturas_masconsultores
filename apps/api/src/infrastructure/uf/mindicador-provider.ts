import type { UfProvider, UfProviderResult } from '../../application/uf/uf-provider.js';
import { UfProviderError } from '../../application/uf/uf-provider.js';
import { decimalToString, parseDecimalString } from '../../domain/calculation/decimal.js';
import { ufDateParts } from '../../domain/uf/uf-date.js';
import type { SafeHttpClient } from './safe-http-client.js';
import { SafeHttpError } from './safe-http-client.js';

export function parseMindicadorUfJson(body: string, date: string): string | null {
  let document: unknown;
  try {
    document = JSON.parse(body) as unknown;
  } catch {
    throw new Error('JSON inválido de mindicador.cl');
  }
  if (!document || typeof document !== 'object' || !('serie' in document)) {
    throw new Error('Contrato inesperado de mindicador.cl');
  }

  for (const object of body.matchAll(/\{[^{}]*\}/g)) {
    const fragment = object[0];
    const dateMatch = /"fecha"\s*:\s*"([^"]+)"/.exec(fragment);
    if (!dateMatch?.[1]?.startsWith(date)) continue;
    const valueMatch = /"valor"\s*:\s*("?)(\d+(?:\.\d+)?)\1/.exec(fragment);
    if (!valueMatch?.[2]) throw new Error('Valor inválido de mindicador.cl');
    return decimalToString(
      parseDecimalString(valueMatch[2], 'mindicador.value', { positive: true }),
    );
  }
  return null;
}

export class MindicadorUfProvider implements UfProvider {
  readonly name = 'mindicador.cl' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly http: SafeHttpClient,
  ) {}

  async fetch(date: string): Promise<UfProviderResult> {
    const { year } = ufDateParts(date);
    const url = new URL(`uf/${year}`, this.baseUrl);
    try {
      const body = await this.http.get(url, ['application/json']);
      let value: string | null;
      try {
        value = parseMindicadorUfJson(body, date);
      } catch (error) {
        throw new UfProviderError(
          this.name,
          'invalid-response',
          error instanceof Error ? error.message : 'Respuesta inválida de mindicador.cl',
        );
      }
      return value
        ? { status: 'found', value, sourceReference: url.toString() }
        : { status: 'not-published' };
    } catch (error) {
      if (error instanceof UfProviderError) throw error;
      if (error instanceof SafeHttpError) {
        if (error.kind === 'not-found') return { status: 'not-published' };
        throw new UfProviderError(this.name, error.kind, error.message);
      }
      throw error;
    }
  }
}
