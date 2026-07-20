import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashIdentifier(identifier: string): string {
  return hashToken(identifier.trim().normalize('NFKC').toLocaleLowerCase('es-CL'));
}

export function minimizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  const candidate = mapped ?? ip;
  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;

  if (candidate.includes(':')) {
    const parts = candidate.split(':').filter(Boolean);
    return `${parts.slice(0, 3).join(':')}::/48`;
  }
  return null;
}
