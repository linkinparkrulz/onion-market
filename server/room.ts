import type { WebSocket } from 'ws';
import type { ClientMsg, PlayerState, ServerMsg, Portal, Stall } from '../shared/protocol.ts';
import type { Session } from './auth47.ts';

interface Player extends PlayerState {
  ws: WebSocket;
  payCode: string;      // server-side only — never broadcast
  lastMove: number;
  lastChat: number;
}

export interface RoomOpts {
  name: string;
  w: number;
  h: number;
  blocked?: string[];
  stalls?: Stall[];
  // Mint a destination-bound SSO token for a player hopping to `dest`. Returns null
  // if the destination isn't a trusted peer.
  mint?: (payCode: string, nym: string | null, dest: string) => string | null;
}

export class Room {
  private players = new Map<number, Player>();
  private nextId = 1;
  private name: string;
  private w: number;
  private h: number;
  private baseBlocked: Set<string>;   // walls + stall tiles (static)
  private blocked: Set<string>;       // baseBlocked + current portal tiles
  private stalls: Stall[];
  private portals: Portal[] = [];
  private mint?: RoomOpts['mint'];

  constructor(opts: RoomOpts) {
    this.name = opts.name;
    this.w = opts.w;
    this.h = opts.h;
    this.stalls = opts.stalls ?? [];
    this.baseBlocked = new Set([...(opts.blocked ?? []), ...this.stalls.map((s) => s.tile)]);
    this.blocked = new Set(this.baseBlocked);
    this.mint = opts.mint;
    setInterval(() => this.tick(), 125).unref();
  }

  // Replace the room's portal doors (directory lobby reflects live gossip).
  setPortals(portals: Portal[]): void {
    this.portals = portals.filter((p) => !this.baseBlocked.has(p.tile));
    this.blocked = new Set([...this.baseBlocked, ...this.portals.map((p) => p.tile)]);
  }

  join(ws: WebSocket, sess: Session): void {
    const id = this.nextId++;
    const [x, y] = this.findSpawn();
    const p: Player = {
      id, ws, nym: sess.nymName ?? 'guest', avatar: sess.avatar, payCode: sess.paymentCode,
      x, y, lastMove: 0, lastChat: 0,
    };
    this.players.set(id, p);

    const init: ServerMsg = {
      t: 'init', you: id, name: this.name,
      map: { w: this.w, h: this.h, blocked: [...this.blocked] },
      players: this.roster(),
      portals: this.portals.length ? this.portals : undefined,
      stalls: this.stalls.length ? this.stalls : undefined,
    };
    ws.send(JSON.stringify(init));
    this.broadcast({ t: 'join', player: this.pub(p) }, id);

    ws.on('message', (raw) => this.onMessage(p, raw));
    ws.on('close', () => { this.players.delete(id); this.broadcast({ t: 'leave', id }); });
  }

  private onMessage(p: Player, raw: unknown): void {
    let m: ClientMsg;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t === 'move') this.move(p, m.x, m.y);
    else if (m.t === 'chat') this.chat(p, m.text);
    else if (m.t === 'portal') this.portal(p, m.dest);
  }

  private portal(p: Player, dest: string): void {
    if (typeof dest !== 'string' || !this.mint) return;
    const token = this.mint(p.payCode, p.nym, dest);
    if (token) p.ws.send(JSON.stringify({ t: 'sso', dest, token } satisfies ServerMsg));
  }

  private move(p: Player, x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (this.blocked.has(x + ',' + y)) return;
    if (Math.abs(x - p.x) + Math.abs(y - p.y) !== 1) return;
    const now = Date.now();
    if (now - p.lastMove < 200) return;
    p.lastMove = now;
    p.x = x; p.y = y;
  }

  private chat(p: Player, text: string): void {
    if (typeof text !== 'string' || !text.trim()) return;
    const now = Date.now();
    if (now - p.lastChat < 800) return;
    p.lastChat = now;
    this.broadcast({ t: 'chat', id: p.id, nym: p.nym, text: text.slice(0, 140) });
  }

  private roster(): PlayerState[] { return [...this.players.values()].map((p) => this.pub(p)); }
  private pub(p: Player): PlayerState { return { id: p.id, nym: p.nym, avatar: p.avatar, x: p.x, y: p.y }; }
  private tick(): void { if (this.players.size) this.broadcast({ t: 'state', players: this.roster() }); }

  private broadcast(obj: ServerMsg, exceptId: number | null = null): void {
    const s = JSON.stringify(obj);
    for (const p of this.players.values())
      if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
  }

  private findSpawn(): [number, number] {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++)
      if (!this.blocked.has(x + ',' + y) && ![...this.players.values()].some((q) => q.x === x && q.y === y))
        return [x, y];
    return [0, 0];
  }
}
