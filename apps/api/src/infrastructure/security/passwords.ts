import { hash, verify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import type { Env } from '../../config/env.js';
import { assertPasswordPolicy, type PasswordIdentity } from '../../domain/auth/password-policy.js';

export class PasswordService {
  constructor(private readonly env: Env) {}

  async hash(password: string, identity: PasswordIdentity): Promise<string> {
    assertPasswordPolicy(password, identity);
    return hash(password, {
      // @node-rs/argon2 declara Algorithm como const enum ambiental, que no es
      // compatible con verbatimModuleSyntax. El valor documentado 2 es Argon2id.
      algorithm: 2,
      memoryCost: this.env.PASSWORD_HASH_MEMORY_KIB,
      timeCost: this.env.PASSWORD_HASH_TIME_COST,
      parallelism: this.env.PASSWORD_HASH_PARALLELISM,
      outputLen: 32,
    });
  }

  async verify(hashValue: string, password: string): Promise<boolean> {
    if (password.length > 128) return false;
    try {
      return await verify(hashValue, password);
    } catch {
      return false;
    }
  }

  generateTemporary(identity: PasswordIdentity): string {
    const groups = [
      'ABCDEFGHJKLMNPQRSTUVWXYZ',
      'abcdefghijkmnopqrstuvwxyz',
      '23456789',
      '!@#$%*-_=+?',
    ];
    const all = groups.join('');
    const characters = groups.map((group) => group[randomInt(group.length)] ?? 'A');
    while (characters.length < 20) characters.push(all[randomInt(all.length)] ?? 'a');

    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1);
      [characters[index], characters[swapIndex]] = [
        characters[swapIndex] ?? '',
        characters[index] ?? '',
      ];
    }

    const password = characters.join('');
    assertPasswordPolicy(password, identity);
    return password;
  }
}
