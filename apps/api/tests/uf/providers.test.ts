import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SafeHttpClient, SafeHttpError } from '../../src/infrastructure/uf/safe-http-client.js';
import { parseSiiUfHtml, SiiUfProvider } from '../../src/infrastructure/uf/sii-provider.js';
import {
  MindicadorUfProvider,
  parseMindicadorUfJson,
} from '../../src/infrastructure/uf/mindicador-provider.js';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const servers: Server[] = [];

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Servidor de prueba sin puerto');
  return { baseUrl: `http://127.0.0.1:${address.port}/` };
}

afterEach(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  );
});

describe('proveedores UF sin Internet', () => {
  it('parsea fixtures locales SII y mindicador conservando string decimal', async () => {
    const sii = await readFile(resolve(fixtureRoot, 'sii-uf-year.html'), 'utf8');
    const mindicador = await readFile(resolve(fixtureRoot, 'mindicador-uf-year.json'), 'utf8');
    expect(parseSiiUfHtml(sii, '2024-01-15')).toBe('36815.55');
    expect(parseSiiUfHtml(sii, '2024-01-16')).toBeNull();
    expect(parseMindicadorUfJson(mindicador, '2024-01-15')).toBe('36815.55');
    expect(parseMindicadorUfJson(mindicador, '2024-01-16')).toBeNull();
  });

  it('consulta SII y mindicador mediante un servidor HTTP simulado', async () => {
    const siiBody = await readFile(resolve(fixtureRoot, 'sii-uf-year.html'), 'utf8');
    const mindicadorBody = await readFile(resolve(fixtureRoot, 'mindicador-uf-year.json'), 'utf8');
    const { baseUrl } = await listen((request, response) => {
      if (request.url === '/uf2024.htm') {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(siiBody);
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(mindicadorBody);
      }
    });
    const http = new SafeHttpClient({
      environment: 'test',
      timeoutMs: 1_000,
      retries: 0,
      userAgent: 'FactuFlow-Test',
    });
    await expect(new SiiUfProvider(baseUrl, http).fetch('2024-01-15')).resolves.toMatchObject({
      status: 'found',
      value: '36815.55',
    });
    await expect(
      new MindicadorUfProvider(`${baseUrl}api/`, http).fetch('2024-01-15'),
    ).resolves.toMatchObject({ status: 'found', value: '36815.55' });
  });

  it('reintenta fallos temporales con límite y no reintenta respuestas inválidas', async () => {
    let attempts = 0;
    let healthy = false;
    const { baseUrl } = await listen((_request, response) => {
      attempts += 1;
      if (!healthy && attempts < 3) {
        response.statusCode = 503;
        response.end('temporal');
        return;
      }
      response.setHeader('content-type', 'text/plain');
      response.end('ok');
    });
    const http = new SafeHttpClient({
      environment: 'test',
      timeoutMs: 1_000,
      retries: 2,
      userAgent: 'FactuFlow-Test',
      wait: () => Promise.resolve(),
    });
    await expect(http.get(new URL(baseUrl), ['text/plain'])).resolves.toBe('ok');
    expect(attempts).toBe(3);

    attempts = 0;
    healthy = true;
    const bad = new SafeHttpClient({
      environment: 'test',
      timeoutMs: 1_000,
      retries: 4,
      userAgent: 'FactuFlow-Test',
      wait: () => Promise.resolve(),
    });
    await expect(bad.get(new URL(baseUrl), ['application/json'])).rejects.toMatchObject({
      kind: 'invalid-response',
    });
    expect(attempts).toBe(1);
  });

  it('cancela por timeout y bloquea destinos SSRF fuera de test', async () => {
    const { baseUrl } = await listen((_request, response) => {
      setTimeout(() => {
        response.end('tarde');
      }, 100);
    });
    const http = new SafeHttpClient({
      environment: 'test',
      timeoutMs: 20,
      retries: 1,
      userAgent: 'FactuFlow-Test',
      wait: () => Promise.resolve(),
    });
    await expect(http.get(new URL(baseUrl), ['text/plain'])).rejects.toMatchObject({
      kind: 'temporary',
    });

    const production = new SafeHttpClient({
      environment: 'production',
      timeoutMs: 100,
      retries: 0,
      userAgent: 'FactuFlow-Test',
    });
    await expect(
      production.get(new URL('http://127.0.0.1/uf'), ['text/html']),
    ).rejects.toBeInstanceOf(SafeHttpError);
  });
});
