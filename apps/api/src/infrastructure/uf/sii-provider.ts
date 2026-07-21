import type { UfProvider, UfProviderResult } from '../../application/uf/uf-provider.js';
import { UfProviderError } from '../../application/uf/uf-provider.js';
import { decimalToString, parseDecimalString } from '../../domain/calculation/decimal.js';
import { ufDateParts } from '../../domain/uf/uf-date.js';
import type { SafeHttpClient } from './safe-http-client.js';
import { SafeHttpError } from './safe-http-client.js';

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

function text(cell: string): string {
  return cell
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChileanDecimal(raw: string): string | null {
  const cleaned = raw.replace(/\$/g, '').replace(/\s/g, '');
  if (!/^\d{1,3}(?:\.\d{3})*,\d{1,6}$/.test(cleaned)) return null;
  const canonical = cleaned.replace(/\./g, '').replace(',', '.');
  try {
    return decimalToString(parseDecimalString(canonical, 'SII.value', { positive: true }));
  } catch {
    return null;
  }
}

function tableRows(table: string): string[][] {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...(row[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      text(cell[1] ?? ''),
    ),
  );
}

export function parseSiiUfHtml(html: string, date: string): string | null {
  const { month, day } = ufDateParts(date);
  const monthName = MONTHS[month - 1];
  if (!monthName) return null;

  for (const tableMatch of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const table = tableMatch[0];
    const rows = tableRows(table);
    const header = rows.find((row) => row.some((cell) => cell.toLowerCase().includes(monthName)));
    if (header) {
      const monthColumn = header.findIndex((cell) => cell.toLowerCase().includes(monthName));
      for (const row of rows) {
        if (row[0] === String(day)) {
          const parsed = parseChileanDecimal(row[monthColumn] ?? '');
          if (parsed) return parsed;
        }
      }
    }

    const start = tableMatch.index ?? 0;
    const context = text(html.slice(Math.max(0, start - 600), start)).toLowerCase();
    if (!context.includes(monthName) && !text(table).toLowerCase().includes(monthName)) continue;
    for (const row of rows) {
      if (row[0] !== String(day)) continue;
      for (const cell of row.slice(1)) {
        const parsed = parseChileanDecimal(cell);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

export class SiiUfProvider implements UfProvider {
  readonly name = 'sii.cl' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly http: SafeHttpClient,
  ) {}

  async fetch(date: string): Promise<UfProviderResult> {
    const { year } = ufDateParts(date);
    const url = new URL(`uf${year}.htm`, this.baseUrl);
    try {
      const body = await this.http.get(url, ['text/html']);
      const value = parseSiiUfHtml(body, date);
      return value
        ? { status: 'found', value, sourceReference: url.toString() }
        : { status: 'not-published' };
    } catch (error) {
      if (error instanceof SafeHttpError) {
        if (error.kind === 'not-found') return { status: 'not-published' };
        throw new UfProviderError(this.name, error.kind, error.message);
      }
      throw error;
    }
  }
}
