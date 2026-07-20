import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GUARDIA 4 — Los límites entre capas.
 *
 * ESLint ya bloquea esto (`no-restricted-imports` en eslint.config.js). Esta
 * prueba existe porque una regla de lint se puede desactivar con un
 * `// eslint-disable-next-line` en la línea de arriba, y nadie lo nota en un
 * diff grande. Esta prueba no se puede silenciar sin que aparezca en el diff
 * como lo que es: quitar una barrera a propósito.
 *
 * Dirección permitida:
 *   presentation → application → domain
 *   infrastructure → domain
 *   domain → (nada)
 */

const apiSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const IMPORT_PATTERN = /^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm;

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

async function importsOf(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

describe('Guardia: límites entre capas', () => {
  it('el dominio no importa infraestructura, presentación ni frameworks', async () => {
    const forbidden = [
      /^pg$/,
      /^pg-/,
      /^kysely/,
      /^fastify/,
      /^@fastify\//,
      /^node-pg-migrate$/,
      /infrastructure\//,
      /presentation\//,
      /application\//,
    ];

    const files = await listTypeScriptFiles(join(apiSrc, 'domain'));
    expect(files.length).toBeGreaterThan(0); // si no hay archivos, la prueba no prueba nada

    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of await importsOf(file)) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          violations.push(`${relative(apiSrc, file)} → '${specifier}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('la capa de aplicación no habla SQL ni HTTP', async () => {
    const forbidden = [/^pg$/, /^kysely/, /^fastify/, /^@fastify\//, /presentation\//];

    let files: string[];
    try {
      files = await listTypeScriptFiles(join(apiSrc, 'application'));
    } catch {
      files = []; // la carpeta está vacía en la Fase 1, a propósito
    }

    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of await importsOf(file)) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          violations.push(`${relative(apiSrc, file)} → '${specifier}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('la capa de presentación no importa el driver de PostgreSQL directamente', async () => {
    const files = await listTypeScriptFiles(join(apiSrc, 'presentation'));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of await importsOf(file)) {
        if (/^pg$/.test(specifier) || /^pg-/.test(specifier)) {
          violations.push(`${relative(apiSrc, file)} → '${specifier}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
