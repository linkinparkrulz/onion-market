import { randomBytes } from 'node:crypto';
import { verifySig, type Identity } from './identity.ts';

// A destination-bound SSO voucher. The issuer (a directory mirror) asserts that
// `code` authenticated with it, bound to a single destination onion and short-lived.
export interface SSOPayload {
  code: string;
  nym: string | null;
  iss: string;   // issuer onion (whose pubkey verifies this token)
  dest: string;  // destination onion this token is valid for
  exp: number;   // ms epoch
  jti: string;   // unique id, for replay rejection at the destination
}

const TTL_MS = 2 * 60 * 1000;

// Issued by node X, bound to destination Y. Signed with X's Ed25519 key.
export function mintSSOToken(id: Identity, selfOnion: string, params: { code: string; nym: string | null; dest: string }): string {
  const payload: SSOPayload = {
    code: params.code,
    nym: params.nym,
    iss: selfOnion,
    dest: params.dest,
    exp: Date.now() + TTL_MS,
    jti: randomBytes(12).toString('hex'),
  };
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + id.sign(p);
}

// Parse the payload WITHOUT verifying — used to read `iss` so the destination can
// look up the issuer's pubkey before verifying.
export function parseSSO(token: string): SSOPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed SSO token');
  return JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as SSOPayload;
}

// Verify signature (against the issuer's gossiped pubkey), destination binding, and expiry.
// The caller must additionally confirm the issuer is a trusted peer and `jti` is unused.
export function verifySSOToken(issuerPubKeyB64: string, expectedDest: string, token: string): SSOPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed SSO token');
  if (!verifySig(issuerPubKeyB64, parts[0], parts[1])) throw new Error('invalid SSO signature');
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as SSOPayload;
  if (payload.dest !== expectedDest) throw new Error('SSO token not addressed to this node');
  if (Date.now() > payload.exp) throw new Error('SSO token expired');
  return payload;
}
