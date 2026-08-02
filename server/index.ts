import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { Auth47Service } from './auth47.ts';
import { PayNymService } from './paynym.ts';
import { Room } from './room.ts';
import { createSSOToken, verifySSOToken, generateSSOSecret } from './sso.ts';
import type { Auth47Proof, Portal } from '../shared/protocol.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:' + PORT;

// SSO secret — shared between directory and vendor instances
const SSO_SECRET = process.env.SSO_SECRET ?? generateSSOSecret();
if (!process.env.SSO_SECRET) console.log('[sso] generated secret (set SSO_SECRET env to persist):', SSO_SECRET);

// Load vendor directory
const VENDORS_FILE = path.join(__dirname, '..', 'vendors.json');
let portals: Portal[] = [];
if (existsSync(VENDORS_FILE)) {
  try {
    portals = JSON.parse(readFileSync(VENDORS_FILE, 'utf-8'));
    console.log('[directory] loaded', portals.length, 'portals');
  } catch (e) {
    console.log('[directory] failed to load vendors.json:', (e as Error).message);
  }
}

const auth = new Auth47Service({ callbackUrl: BASE_URL + '/api/auth47/callback' });
const nyms = new PayNymService(path.join(__dirname, '..', 'cache', 'avatars'));
const room = new Room({ portals });

const json = (res: ServerResponse, code: number, obj: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
};

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', BASE_URL);

  // --- SSO: verify token from directory, create local session, redirect ---
  const ssoParam = url.searchParams.get('sso');
  if (ssoParam && SSO_SECRET && url.pathname === '/') {
    try {
      const { code, nym } = verifySSOToken(SSO_SECRET, ssoParam);
      const localToken = randomBytes(32).toString('hex');
      auth.createSessionFromSSO(localToken, code, nym);
      // Resolve PayNym in background
      nyms.resolve(code).then((profile) => {
        const s = auth.getSession(localToken);
        if (s && profile) s.nymName = profile.nymName;
      }).catch(() => {});
      console.log('[sso] verified, created session for', code.slice(0, 14) + '...');
      res.writeHead(302, { Location: '/?token=' + localToken });
      return res.end();
    } catch (e) {
      console.log('[sso] verification failed:', (e as Error).message);
      // Fall through to normal page load
    }
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
      // Generate SSO token for portal navigation
      if (SSO_SECRET) {
        auth.attachSSOToken(token, createSSOToken(SSO_SECRET, paymentCode, profile?.nymName ?? null));
      }
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

  // --- PayNym avatar proxy ---
  if (url.pathname.startsWith('/api/avatar/') && req.method === 'GET') {
    try {
      const file = await nyms.ensureAvatar(url.pathname.split('/').pop() ?? '');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(await readFile(file));
    } catch { return json(res, 404, { error: 'avatar unavailable' }); }
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
  const token = new URL(req.url ?? '/', BASE_URL).searchParams.get('token') ?? '';
  const sess = auth.getSession(token);
  console.log('[ws] connection, token', token.slice(0, 8) + '...', sess ? 'session OK' : 'REJECTED');
  if (!sess) return ws.close(4001, 'unauthorized');
  room.join(ws, sess);
});

server.listen(PORT, () => console.log('room listening on :' + PORT));
