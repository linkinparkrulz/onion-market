import { randomBytes } from 'node:crypto';
import * as ecc from 'tiny-secp256k1';
import { Auth47Verifier } from '@samouraiwallet/auth47';
import type { Auth47Proof } from '../shared/protocol.ts';
import { avatarIdFor } from './paynym.ts';

const TTL_MS = 5 * 60 * 1000;

interface Challenge { expiresAt: number; used: boolean }
export interface Session { paymentCode: string; nymName: string | null; avatar: string }

const parseNonce = (uri?: string): string | null => {
  const m = /^auth47:\/\/([0-9a-f]{32})/i.exec(uri ?? '');
  return m ? m[1].toLowerCase() : null;
};

export class Auth47Service {
  private verifier: Auth47Verifier;
  private callbackUrl: string;
  private challenges = new Map<string, Challenge>();
  private sessions = new Map<string, Session>();
  private byNonce = new Map<string, string>();

  constructor(opts: { callbackUrl: string }) {
    this.callbackUrl = opts.callbackUrl;
    this.verifier = new Auth47Verifier(ecc, opts.callbackUrl);
    setInterval(() => this.sweep(), 60_000).unref();
  }

  createChallenge(): { nonce: string; uri: string; expires: number } {
    const nonce = randomBytes(16).toString('hex');
    const expires = Math.floor(Date.now() / 1000) + TTL_MS / 1000;
    const uri = 'auth47://' + nonce + '?c=' + this.callbackUrl + '&e=' + expires + '&r=' + this.callbackUrl;
    this.challenges.set(nonce, { expiresAt: Date.now() + TTL_MS, used: false });
    return { nonce, uri, expires };
  }

  async verifyProof(proof: Auth47Proof): Promise<{ nonce: string; token: string; paymentCode: string }> {
    const nonce = parseNonce(proof?.challenge);
    const ch = nonce ? this.challenges.get(nonce) : undefined;
    if (!nonce || !ch) throw new Error('unknown challenge');
    if (ch.used) throw new Error('challenge already spent');
    if (Date.now() > ch.expiresAt) throw new Error('challenge expired');

    const result = this.verifier.verifyProof({
      auth47_response: proof.auth47_response ?? proof.challenge,
      challenge: proof.challenge,
      nym: proof.nym,
      signature: proof.signature,
    }, 'bitcoin');
    if (result.result !== 'ok') throw new Error('invalid proof: ' + result.error);

    ch.used = true;
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { paymentCode: proof.nym, nymName: null, avatar: avatarIdFor(proof.nym) });
    return { nonce, token, paymentCode: proof.nym };
  }

  attachProfile(token: string, profile: { nymName: string | null } | null): void {
    const s = this.sessions.get(token);
    if (s) s.nymName = profile?.nymName ?? null;
  }

  createSessionFromSSO(token: string, paymentCode: string, nymName: string | null): void {
    this.sessions.set(token, { paymentCode, nymName, avatar: avatarIdFor(paymentCode) });
  }

  complete(nonce: string, token: string): void {
    this.byNonce.set(nonce.toLowerCase(), token);
  }

  poll(nonce: string): string | null {
    const token = this.byNonce.get(nonce.toLowerCase());
    if (token) this.byNonce.delete(nonce.toLowerCase());
    return token ?? null;
  }

  getSession(token: string): Session | null {
    return this.sessions.get(token) ?? null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [n, ch] of this.challenges) if (now > ch.expiresAt) this.challenges.delete(n);
  }
}
