import { createHash } from 'node:crypto';
import https from 'node:https';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { NymProfile } from '../shared/protocol.ts';

const LOOKUP = 'https://paynym.rs/api/v1/nym/';
const AVATAR = (code: string) => `https://paynym.rs/${code}/avatar`;

// One-way avatar handle derived from a payment code. Broadcast to clients in place
// of the raw BIP47 code so payment codes can't be harvested from a room.
export function avatarIdFor(paymentCode: string): string {
  return createHash('sha256').update(paymentCode).digest('hex').slice(0, 24);
}

const agent = process.env.TOR_SOCKS ? new SocksProxyAgent(process.env.TOR_SOCKS) : undefined;

interface FetchResult { status: number; body: Buffer }

function fetchBuf(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init?.method ?? 'GET', headers: init?.headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    if (init?.body) req.write(init.body);
    req.end();
  });
}

interface LookupResponse { nymName?: string; nymID?: string }

export class PayNymService {
  private byCode = new Map<string, NymProfile>();
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  async resolve(paymentCode: string): Promise<NymProfile> {
    const cached = this.byCode.get(paymentCode);
    if (cached) return cached;
    const res = await fetchBuf(LOOKUP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nym: paymentCode }),
    });
    if (res.status !== 200) throw new Error(`nym lookup failed: ${res.status}`);
    const data = JSON.parse(res.body.toString()) as LookupResponse;
    const profile: NymProfile = { paymentCode, nymName: data.nymName ?? null, nymID: data.nymID ?? null };
    this.byCode.set(paymentCode, profile);
    this.ensureAvatar(paymentCode).catch(() => {});
    return profile;
  }

  // Absolute path of the cached avatar for a handle (may not exist yet).
  fileForId(avatarId: string): string {
    return path.join(this.cacheDir, avatarId + '.png');
  }

  async ensureAvatar(paymentCode: string): Promise<string> {
    return this.ensureAvatarById(avatarIdFor(paymentCode), paymentCode);
  }

  // Fetch + cache the avatar under its handle. Called at session creation so the
  // per-id avatar route can serve it without ever seeing the raw payment code.
  async ensureAvatarById(avatarId: string, paymentCode: string): Promise<string> {
    const file = this.fileForId(avatarId);
    try { await readFile(file); return file; } catch {}
    const res = await fetchBuf(AVATAR(paymentCode));
    if (res.status !== 200) throw new Error(`avatar fetch failed: ${res.status}`);
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(file, res.body);
    return file;
  }
}
