import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import {
  PasswordPolicyError,
  assertPasswordPolicy,
} from '../../src/domain/auth/password-policy.js';
import { PasswordService } from '../../src/infrastructure/security/passwords.js';

const identity = { username: 'test.admin', email: 'test.admin@example.invalid' };
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL_APP: 'postgresql://factuflow_app:test@localhost/factuflow',
  PASSWORD_HASH_MEMORY_KIB: '8192',
  PASSWORD_HASH_TIME_COST: '2',
});

describe('contraseñas Argon2id', () => {
  it('genera un hash Argon2id y verifica sólo la contraseña correcta', async () => {
    const service = new PasswordService(env);
    const hash = await service.hash('Correct-Horse-42!', identity);

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(service.verify(hash, 'Correct-Horse-42!')).resolves.toBe(true);
    await expect(service.verify(hash, 'Incorrect-Horse-42!')).resolves.toBe(false);
    expect(hash).not.toContain('Correct-Horse-42!');
  });

  it('genera contraseñas temporales que cumplen la política', () => {
    const password = new PasswordService(env).generateTemporary(identity);
    expect(password).toHaveLength(20);
    expect(() => assertPasswordPolicy(password, identity)).not.toThrow();
  });
});

describe('política de contraseñas', () => {
  it.each([
    ['muy corta', 'Corta-42!'],
    ['demasiado larga', `Aa1!${'x'.repeat(130)}`],
    ['igual al username', 'test.admin'],
    ['igual al correo', 'test.admin@example.invalid'],
    ['común', 'Password123!'],
    ['sin diversidad', 'solamenteletras'],
  ])('rechaza %s', (_case, password) => {
    expect(() => assertPasswordPolicy(password, identity)).toThrow(PasswordPolicyError);
  });
});
