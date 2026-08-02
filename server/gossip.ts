import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { verifySig, type Identity } from './identity.ts';
import type { PeerRecord } from '../shared/protocol.ts';

const RECORD_TTL_MS = 24 * 60 * 60 * 1000; // prune peers not refreshed within a day
const GOSSIP_INTERVAL_MS = 60_000;
const MAX_STR = 96;

// Canonical bytes a record is signed over (sig field blanked).
function canonical(rec: PeerRecord): string {
  return JSON.stringify({ onion: rec.onion, pubKey: rec.pubKey, name: rec.name, desc: rec.desc, updatedAt: rec.updatedAt, sig: '' });
}

// Self-sign a peer record with this node's key.
export function signRecord(id: Identity, rec: Omit<PeerRecord, 'sig'>): PeerRecord {
  const full: PeerRecord = { ...rec, sig: '' };
  return { ...full, sig: id.sign(canonical(full)) };
}

function recordValid(rec: PeerRecord): boolean {
  if (!rec || typeof rec.onion !== 'string' || typeof rec.pubKey !== 'string' || typeof rec.sig !== 'string'
    || typeof rec.name !== 'string' || typeof rec.desc !== 'string' || typeof rec.updatedAt !== 'number') return false;
  if (rec.onion.length > MAX_STR || rec.name.length > MAX_STR || rec.desc.length > MAX_STR) return false;
  return verifySig(rec.pubKey, canonical(rec), rec.sig);
}

export interface Seed { onion: string; pubKey: string; name?: string; desc?: string }

export interface GossipOpts {
  id: Identity;
  self: { onion: string; name: string; desc: string };
  seeds: Seed[];
  torSocks?: string;
  storeFile?: string;
}

export class Gossip {
  private peers = new Map<string, PeerRecord>();
  private self: PeerRecord;
  private selfOnion: string;
  private agent?: SocksProxyAgent;
  private storeFile: string;
  private listeners: (() => void)[] = [];

  constructor(opts: GossipOpts) {
    this.selfOnion = opts.self.onion;
    this.agent = opts.torSocks ? new SocksProxyAgent(opts.torSocks) : undefined;
    this.storeFile = opts.storeFile ?? path.join('data', 'peers.json');
    this.self = signRecord(opts.id, {
      onion: opts.self.onion, pubKey: opts.id.publicKeyB64,
      name: opts.self.name, desc: opts.self.desc, updatedAt: Date.now(),
    });
    this.peers.set(this.selfOnion, this.self);
    this.loadStore();
    // Seed the onion↔pubkey pins (unsigned placeholders, replaced on first gossip).
    for (const s of opts.seeds) {
      if (s.onion === this.selfOnion || this.peers.has(s.onion) || !s.pubKey) continue;
      this.peers.set(s.onion, { onion: s.onion, pubKey: s.pubKey, name: s.name ?? s.onion, desc: s.desc ?? '', updatedAt: 0, sig: '' });
    }
  }

  onUpdate(fn: () => void): void { this.listeners.push(fn); }
  private emit(): void { for (const l of this.listeners) { try { l(); } catch { /* ignore */ } } }

  peersList(): PeerRecord[] { return [...this.peers.values()]; }
  getPeer(onion: string): PeerRecord | undefined { return this.peers.get(onion); }
  // Only signed records are gossiped onward.
  export(): PeerRecord[] { return this.peersList().filter((r) => r.sig); }

  // Merge an incoming record with TOFU pubkey pinning.
  merge(rec: PeerRecord): boolean {
    if (rec.onion === this.selfOnion) return false;     // never override self
    if (!recordValid(rec)) return false;
    const existing = this.peers.get(rec.onion);
    if (existing) {
      if (existing.pubKey && existing.pubKey !== rec.pubKey) return false;   // pinned key mismatch → reject
      if (existing.sig && existing.updatedAt >= rec.updatedAt) return false; // not newer
    }
    this.peers.set(rec.onion, rec);
    return true;
  }

  start(): void {
    this.pull();
    // Warm-up retries so peers that came up in a different order converge in seconds,
    // not a full interval (the first pull can miss a peer still starting).
    for (const d of [3_000, 8_000, 20_000]) setTimeout(() => this.pull(), d).unref();
    setInterval(() => this.pull(), GOSSIP_INTERVAL_MS).unref();
    setInterval(() => this.prune(), GOSSIP_INTERVAL_MS).unref();
  }

  private prune(): void {
    const now = Date.now();
    for (const [onion, rec] of this.peers) {
      if (onion === this.selfOnion) continue;
      if (rec.sig && now - rec.updatedAt > RECORD_TTL_MS) this.peers.delete(onion);
    }
  }

  private async pull(): Promise<void> {
    let changed = false;
    for (const peer of this.peersList()) {
      if (peer.onion === this.selfOnion) continue;
      try {
        const records = await this.fetchPeers(peer.onion);
        for (const r of records) if (this.merge(r)) changed = true;
      } catch { /* peer offline — try next cycle */ }
    }
    if (changed) { this.saveStore(); this.emit(); }
  }

  private fetchPeers(onion: string): Promise<PeerRecord[]> {
    return new Promise((resolve, reject) => {
      const req = http.request('http://' + onion + '/api/gossip/peers', { agent: this.agent, timeout: 15_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  private loadStore(): void {
    try {
      const arr = JSON.parse(readFileSync(this.storeFile, 'utf-8')) as PeerRecord[];
      for (const r of arr) this.merge(r);
    } catch { /* no store yet */ }
  }

  private saveStore(): void {
    try {
      mkdirSync(path.dirname(this.storeFile), { recursive: true });
      writeFileSync(this.storeFile, JSON.stringify(this.export(), null, 2));
    } catch { /* best effort */ }
  }
}
