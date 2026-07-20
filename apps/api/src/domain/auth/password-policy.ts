const COMMON_PASSWORDS = new Set([
  'password123!',
  'contraseña123!',
  'contrasena123!',
  'admin123456!',
  'qwerty123456!',
  '1234567890Aa!',
  'factuflow123!',
]);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export class PasswordPolicyError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(reasons.join(' '));
    this.name = 'PasswordPolicyError';
  }
}

export interface PasswordIdentity {
  readonly username: string;
  readonly email: string;
}

export function assertPasswordPolicy(password: string, identity: PasswordIdentity): void {
  const reasons: string[] = [];
  const normalized = password.normalize('NFKC');
  const folded = normalized.toLocaleLowerCase('es-CL');
  const username = identity.username.trim().normalize('NFKC').toLocaleLowerCase('es-CL');
  const email = identity.email.trim().normalize('NFKC').toLocaleLowerCase('es-CL');
  const emailLocal = email.split('@')[0] ?? email;

  if (normalized.length < PASSWORD_MIN_LENGTH) reasons.push('Debe tener al menos 12 caracteres.');
  if (normalized.length > PASSWORD_MAX_LENGTH) reasons.push('No puede superar 128 caracteres.');

  const classes = [/[a-záéíóúñ]/iu, /[A-ZÁÉÍÓÚÑ]/u, /\d/u, /[^\p{L}\p{N}\s]/u].filter((pattern) =>
    pattern.test(normalized),
  ).length;
  if (classes < 3) {
    reasons.push('Debe combinar al menos tres tipos: mayúsculas, minúsculas, números o símbolos.');
  }

  if (folded === username || folded === email || folded === emailLocal) {
    reasons.push('No puede ser igual al username ni al correo.');
  }
  if (COMMON_PASSWORDS.has(folded)) reasons.push('La contraseña es demasiado común.');

  if (reasons.length > 0) throw new PasswordPolicyError(reasons);
}
