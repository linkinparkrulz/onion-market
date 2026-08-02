import { createHmac, randomBytes } from 'node:crypto';

export function createSSOToken(secret: string, paymentCode: string, nymName: string | null): string {
  const payload = JSON.stringify({ code: paymentCode, nym: nymName, exp: Date.now() + 3600000 });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return payloadB64 + '.' + sig;
}

export function verifySSOToken(secret: string, token: string): { code: string; nym: string | null } {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed SSO token');
  const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
  if (parts[1] !== expected) throw new Error('invalid SSO signature');
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (Date.now() > payload.exp) throw new Error('SSO token expired');
  return { code: payload.code, nym: payload.nym ?? null };
}

export function generateSSOSecret(): string {
  return randomBytes(32).toString('hex');
}
