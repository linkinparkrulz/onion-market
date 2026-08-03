import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { Auth47Service } from './auth47.ts';
import { PayNymService, avatarIdFor } from './paynym.ts';
import { CharacterService } from './character.ts';
import { Room } from './room.ts';
import { loadOrCreateIdentity } from './identity.ts';
import { mintSSOToken, verifySSOToken, parseSSO } from './sso.ts';
import { Gossip, type Seed } from './gossip.ts';
import type { Auth47Proof, Portal, RoomConfig } from '../shared/protocol.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:' + PORT;

// This node's network identity (onion, or host:port in dev). Used as SSO issuer/dest.
const SELF_ONION = process.env.SELF_ONION ?? 'localhost:' + PORT;

// Cryptographic identity — replaces the old shared symmetric SSO secret.
const identity = loadOrCreateIdentity();

// --- Vendor room config (optional) ---
const ROOM_FILE = path.join(ROOT, 'room.json');
let vendorCfg: RoomConfig | null = null;
if (existsSync(ROOM_FILE)) {
  try {
    vendorCfg = JSON.parse(readFileSync(ROOM_FILE, 'utf-8'));
    console.log('[room] loaded vendor room:', vendorCfg?.name);
  } catch (e) {
    console.log('[room] failed to load room.json:', (e as Error).message);
  }
}

const NODE_NAME = process.env.NODE_NAME ?? vendorCfg?.name ?? 'onion node';
const NODE_DESC = process.env.NODE_DESC ?? (vendorCfg?.stalls?.[0]?.wares?.[0]?.desc ?? 'a vendor room');

// --- Bootstrap peer seeds ---
const PEERS_FILE = path.join(ROOT, 'peers.json');
let seeds: Seed[] = [];
if (existsSync(PEERS_FILE)) {
  try { seeds = JSON.parse(readFileSync(PEERS_FILE, 'utf-8')); } catch (e) { console.log('[gossip] failed to load peers.json:', (e as Error).message); }
}

const gossip = new Gossip({
  id: identity,
  self: { onion: SELF_ONION, name: NODE_NAME, desc: NODE_DESC },
  seeds,
  torSocks: process.env.TOR_SOCKS,
});

const auth = new Auth47Service({ callbackUrl: BASE_URL + '/api/auth47/callback' });
const nyms = new PayNymService(path.join(ROOT, 'cache', 'avatars'));
// Server-side character sprite generation (Tor Browser blocks client-side canvas readback).
const chars = new CharacterService({ cacheDir: path.join(ROOT, 'cache', 'characters'), bodyPath: path.join(PUBLIC, 'assets', 'samurai-body.png') });
chars.init();

// Mint a destination-bound SSO token, but only for onions we actually trust as peers.
const mint = (payCode: string, nym: string | null, dest: string): string | null => {
  if (!gossip.getPeer(dest)) return null;
  return mintSSOToken(identity, SELF_ONION, { code: payCode, nym, dest });
};

// --- Directory lobby: portals generated from the live peer table ---
const SLOTS: string[] = [];
for (const y of [2, 5, 8]) for (const x of [2, 4, 6, 8, 10]) SLOTS.push(x + ',' + y);
const directoryPortals = (): Portal[] => {
  const peers = gossip.peersList().filter((p) => p.onion !== SELF_ONION || !!vendorRoom);
  return peers.slice(0, SLOTS.length).map((p, i) => ({ tile: SLOTS[i], name: p.name, onion: p.onion, desc: p.desc }));
};

const directoryRoom = new Room({ name: NODE_NAME + ' — directory', w: 12, h: 12, mint });
const vendorRoom = vendorCfg
  ? new Room({ name: vendorCfg.name, w: vendorCfg.w, h: vendorCfg.h, blocked: vendorCfg.blocked, stalls: vendorCfg.stalls, mint })
  : null;

gossip.onUpdate(() => directoryRoom.setPortals(directoryPortals()));
directoryRoom.setPortals(directoryPortals());
gossip.start();

// Precompute a payment QR for each stall (payCode is the vendor's own public code).
if (vendorCfg?.stalls) {
  for (const s of vendorCfg.stalls) {
    if (!s.payCode) continue;
    QRCode.toDataURL(s.payCode, { margin: 1, width: 220 })
      .then((qr) => { s.qr = qr; })
      .catch(() => { /* QR is optional */ });
  }
}

// Replay cache for consumed SSO token ids.
class ReplayCache {
  private seen = new Map<string, number>();
  constructor() { setInterval(() => this.sweep(), 60_000).unref(); }
  has(jti: string): boolean { return this.seen.has(jti); }
  add(jti: string, exp: number): void { this.seen.set(jti, exp); }
  private sweep(): void { const now = Date.now(); for (const [k, e] of this.seen) if (now > e) this.seen.delete(k); }
}
const replay = new ReplayCache();

const json = (res: ServerResponse, code: number, obj: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
};

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', BASE_URL);

  // --- SSO: verify a peer's destination-bound token, create local session, redirect ---
  const ssoParam = url.searchParams.get('sso');
  if (ssoParam && url.pathname === '/') {
    try {
      const payload = parseSSO(ssoParam);
      const peer = gossip.getPeer(payload.iss);
      if (!peer || !peer.pubKey) throw new Error('unknown issuer ' + payload.iss);
      verifySSOToken(peer.pubKey, SELF_ONION, ssoParam); // checks sig + dest + expiry
      if (replay.has(payload.jti)) throw new Error('token replay');
      replay.add(payload.jti, payload.exp);

      const localToken = randomBytes(32).toString('hex');
      auth.createSessionFromSSO(localToken, payload.code, payload.nym);
      nyms.ensureAvatarById(avatarIdFor(payload.code), payload.code).catch(() => {});
      nyms.resolve(payload.code).then((pr) => {
        const s = auth.getSession(localToken);
        if (s && pr) s.nymName = pr.nymName;
      }).catch(() => {});

      const roomParam = url.searchParams.get('room');
      console.log('[sso] accepted from', payload.iss, 'for', payload.code.slice(0, 14) + '...');
      res.writeHead(302, { Location: '/?token=' + localToken + (roomParam ? '&room=' + encodeURIComponent(roomParam) : '') });
      return res.end();
    } catch (e) {
      console.log('[sso] rejected:', (e as Error).message);
      // Fall through to normal page load
    }
  }

  // --- Gossip: serve this node's known signed peer records ---
  if (url.pathname === '/api/gossip/peers' && req.method === 'GET') {
    return json(res, 200, gossip.export());
  }

  // --- Auth47: challenge generation ---
  if (url.pathname === '/api/auth47/challenge' && req.method === 'GET') {
    const ch = auth.createChallenge();
    console.log('[auth47] challenge created, nonce:', ch.nonce);
    const qr = await QRCode.toDataURL(ch.uri, { margin: 1, width: 320 });
    return json(res, 200, { ...ch, qr });
  }

  // --- Auth47: GET callback page ---
  if (url.pathname === '/api/auth47/callback' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><body style="background:#17121f;color:#eee;font-family:monospace;display:grid;place-items:center;height:100vh;margin:0"><p>signed in - return to the barn.</p></body>');
  }

  // --- Auth47: wallet POSTs signed proof ---
  if (url.pathname === '/api/auth47/callback' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    console.log('[auth47] callback received');
    try {
      const { nonce, token, paymentCode } = await auth.verifyProof(JSON.parse(body) as Auth47Proof);
      console.log('[auth47] proof verified, payment code:', paymentCode.slice(0, 14) + '...');
      const profile = await nyms.resolve(paymentCode).catch((e) => {
        console.log('[auth47] paynym lookup failed (non-fatal):', (e as Error).message);
        return null;
      });
      auth.attachProfile(token, profile);
      auth.complete(nonce, token);
      console.log('[auth47] session complete, nonce:', nonce);
      return json(res, 200, { ok: true });
    } catch (err) {
      console.log('[auth47] callback rejected:', (err as Error).message);
      return json(res, 400, { ok: false, error: (err as Error).message });
    }
  }

  // --- Auth47: browser polls for token ---
  if (url.pathname.startsWith('/api/auth47/status/') && req.method === 'GET') {
    const nonce = url.pathname.split('/').pop() ?? '';
    const token = auth.poll(nonce);
    if (token) console.log('[auth47] token handed out, nonce:', nonce);
    return token ? json(res, 200, { token }) : json(res, 202, { pending: true });
  }

  // --- PayNym avatar proxy (served by one-way handle, never the raw code) ---
  if (url.pathname.startsWith('/api/avatar/') && req.method === 'GET') {
    try {
      const file = nyms.fileForId(url.pathname.split('/').pop() ?? '');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(data);
    } catch { return json(res, 404, { error: 'avatar unavailable' }); }
  }

  // --- Character sprite (built server-side; the browser only draws it) ---
  if (url.pathname.startsWith('/api/character/') && req.method === 'GET') {
    const id = (url.pathname.split('/').pop() ?? '').replace(/\.png$/, '');
    const png = await chars.build(id, nyms.fileForId(id)).catch(() => null);
    if (png) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(png);
    }
    return json(res, 404, { error: 'character unavailable' });
  }

  // --- Static files ---
  const p = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!p.startsWith(PUBLIC)) return json(res, 403, {});
  try {
    const data = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  } catch { json(res, 404, { error: 'not found' }); }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const u = new URL(req.url ?? '/', BASE_URL);
  const token = u.searchParams.get('token') ?? '';
  const sess = auth.getSession(token);
  console.log('[ws] connection, token', token.slice(0, 8) + '...', sess ? 'session OK' : 'REJECTED');
  if (!sess) return ws.close(4001, 'unauthorized');
  // Pre-warm avatar → character sprite so it's ready when other clients request it.
  nyms.ensureAvatarById(sess.avatar, sess.paymentCode)
    .then(() => chars.build(sess.avatar, nyms.fileForId(sess.avatar)))
    .catch(() => {});
  const roomName = u.searchParams.get('room') ?? 'directory';
  const r = roomName === 'vendor' && vendorRoom ? vendorRoom : directoryRoom;
  r.join(ws, sess);
});

server.listen(PORT, () => {
  console.log('node', identity.nodeId, 'listening on :' + PORT, '(' + SELF_ONION + ')');
});
