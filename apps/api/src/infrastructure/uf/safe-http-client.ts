import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Env } from '../../config/env.js';

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 2;
const ALLOWED_HOSTS = new Set(['www.sii.cl', 'mindicador.cl']);

export type HttpFailureKind = 'temporary' | 'invalid-response' | 'not-found';

export class SafeHttpError extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'SafeHttpError';
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => parseInt(part, 10));
  const [a = -1, b = -1] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface SafeHttpClientOptions {
  readonly environment: Env['NODE_ENV'];
  readonly timeoutMs: number;
  readonly retries: number;
  readonly userAgent: string;
  readonly fetchImplementation?: typeof fetch;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly resolveHost?: typeof lookup;
}

export class SafeHttpClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly resolveHost: typeof lookup;

  constructor(private readonly options: SafeHttpClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.wait = options.wait ?? delay;
    this.resolveHost = options.resolveHost ?? lookup;
  }

  async get(url: URL, expectedContentTypes: readonly string[]): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      try {
        return await this.getAttempt(url, expectedContentTypes);
      } catch (error) {
        lastError = error;
        if (!(error instanceof SafeHttpError) || error.kind !== 'temporary') throw error;
        if (attempt < this.options.retries) {
          await this.wait(Math.min(200 * 2 ** attempt, 1_000));
        }
      }
    }
    throw lastError;
  }

  private async getAttempt(url: URL, expectedContentTypes: readonly string[]): Promise<string> {
    let current = new URL(url);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await this.assertSafeUrl(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImplementation(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: expectedContentTypes.join(', '),
            'user-agent': this.options.userAgent,
          },
        });
      } catch (error) {
        const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'red';
        throw new SafeHttpError('temporary', `Fallo temporal de ${reason} al consultar UF`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) {
          throw new SafeHttpError('invalid-response', 'Redirección UF inválida o excesiva');
        }
        current = new URL(location, current);
        continue;
      }
      if (response.status === 404) throw new SafeHttpError('not-found', 'Valor UF no publicado');
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new SafeHttpError('temporary', `Proveedor UF respondió HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new SafeHttpError(
          'invalid-response',
          `Proveedor UF respondió HTTP ${response.status}`,
        );
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!expectedContentTypes.some((expected) => contentType.includes(expected))) {
        throw new SafeHttpError('invalid-response', 'Content-Type inesperado del proveedor UF');
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new SafeHttpError('invalid-response', 'Respuesta UF supera el tamaño permitido');
      }
      return this.readLimitedBody(response);
    }
    throw new SafeHttpError('invalid-response', 'Redirección UF inválida');
  }

  private async readLimitedBody(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SafeHttpError('invalid-response', 'Respuesta UF supera el tamaño permitido');
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  private async assertSafeUrl(url: URL): Promise<void> {
    if (url.username || url.password) {
      throw new SafeHttpError('invalid-response', 'La URL UF no admite credenciales');
    }

    const localTestHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (this.options.environment === 'test' && localTestHost) {
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new SafeHttpError('invalid-response', 'Protocolo UF no permitido');
      }
      return;
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.port !== '') {
      throw new SafeHttpError('invalid-response', 'Destino UF no permitido');
    }

    const addresses = await this.resolveHost(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new SafeHttpError(
        'invalid-response',
        'DNS del proveedor UF resolvió a una red privada',
      );
    }
  }
}
