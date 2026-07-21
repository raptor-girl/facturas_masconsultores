import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/config/env.js';

/**
 * Criterio de termino 10 — la aplicacion no arranca si faltan variables.
 */
describe('Validacion de variables de entorno', () => {
  const valid = {
    NODE_ENV: 'test',
    DATABASE_URL_APP: 'postgresql://factuflow_app:x@localhost:5432/factuflow',
  } as NodeJS.ProcessEnv;

  it('acepta una configuracion valida y aplica defaults', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(3000);
    expect(env.API_HOST).toBe('0.0.0.0');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.RATE_LIMIT_MAX).toBe(300);
    expect(env.RATE_LIMIT_WINDOW).toBe('1 minute');
  });

  it('falla si falta DATABASE_URL_APP', () => {
    expect(() => loadEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL_APP/);
  });

  it('falla si DATABASE_URL_APP no es una URL de postgres', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL_APP: 'mysql://x@localhost/y' })).toThrow(
      /postgresql:\/\//,
    );
  });

  it('falla si el puerto no es un numero valido', () => {
    expect(() => loadEnv({ ...valid, API_PORT: 'no-soy-un-puerto' })).toThrow(/API_PORT/);
  });

  it('el mensaje de error enumera TODO lo que falta, no solo lo primero', () => {
    try {
      loadEnv({ API_PORT: 'x', NODE_ENV: 'marte' });
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).toMatch(/DATABASE_URL_APP/);
      expect(message).toMatch(/API_PORT/);
      expect(message).toMatch(/NODE_ENV/);
    }
  });

  it('rechaza la URL del rol propietario en el proceso del API en produccion (T-13)', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
        DATABASE_URL_OWNER: 'postgresql://factuflow_owner:x@localhost:5432/factuflow',
      }),
    ).toThrow(/DATABASE_URL_OWNER/);
  });

  // ── CORS: lista explicita, nunca comodin ─────────────────────────────────
  it('parte CORS_ORIGINS por coma y descarta espacios', () => {
    const env = loadEnv({
      ...valid,
      CORS_ORIGINS: 'http://localhost:5173, https://factuflow.mas.cl',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://factuflow.mas.cl']);
  });

  it('CORS_ORIGINS trae el origen de desarrollo por defecto', () => {
    expect(loadEnv(valid).CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('rechaza el comodin y cualquier origen que no sea una URL', () => {
    // `*` con credenciales es una puerta abierta. Debe fallar al arrancar, no
    // pasar inadvertido hasta que alguien lea la configuracion.
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: 'localhost:5173' })).toThrow(/CORS_ORIGINS/);
  });

  it('rechaza un rate limit no positivo', () => {
    expect(() => loadEnv({ ...valid, RATE_LIMIT_MAX: '0' })).toThrow(/RATE_LIMIT_MAX/);
  });

  it('valida configuración UF, boolean y límites de reintentos', () => {
    const env = loadEnv({ ...valid, UF_CACHE_ENABLED: 'false', UF_REQUEST_RETRIES: '5' });
    expect(env.UF_CACHE_ENABLED).toBe(false);
    expect(env.UF_REQUEST_RETRIES).toBe(5);
    expect(() => loadEnv({ ...valid, UF_REQUEST_RETRIES: '6' })).toThrow(/UF_REQUEST_RETRIES/);
  });

  it('bloquea protocolos y hosts UF no permitidos fuera de tests', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      DATABASE_URL_APP: 'postgresql://factuflow_app:x@database.example.invalid:5432/factuflow',
    };
    expect(() => loadEnv({ ...production, UF_SII_BASE_URL: 'http://www.sii.cl/uf/' })).toThrow(
      /UF_SII_BASE_URL/,
    );
    expect(() =>
      loadEnv({ ...production, UF_MINDICADOR_BASE_URL: 'https://127.0.0.1/api/' }),
    ).toThrow(/UF_MINDICADOR_BASE_URL/);
    expect(() => loadEnv({ ...production, UF_SII_BASE_URL: 'file:///etc/passwd' })).toThrow(
      /UF_SII_BASE_URL/,
    );
  });

  it('permite HTTP local únicamente para proveedores simulados en test', () => {
    expect(
      loadEnv({
        ...valid,
        UF_SII_BASE_URL: 'http://127.0.0.1:31001/',
        UF_MINDICADOR_BASE_URL: 'http://localhost:31002/api/',
      }).UF_SII_BASE_URL,
    ).toBe('http://127.0.0.1:31001/');
  });
});
