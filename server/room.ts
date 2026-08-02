import type { WebSocket } from 'ws';
import type { ClientMsg, PlayerState, ServerMsg, Portal } from '../shared/protocol.ts';
import type { Session } from './auth47.ts';

const MAP = { w: 12, h: 12, blocked: new Set(['4,4', '4,5', '5,4']) };

interface Player extends PlayerState {
  ws: WebSocket;
  lastMove: number;
  lastChat: number;
}

export class Room {
  private players = new Map<number, Player>();
  private nextId = 1;
  private portals: Portal[];

  constructor(opts: { portals?: Portal[] } = {}) {
    this.portals = opts.portals ?? [];
    setInterval(() => this.tick(), 125);
  }

  join(ws: WebSocket, sess: Session): void {
    const id = this.nextId++;
    const [x, y] = this.findSpawn();
    const p: Player = { id, ws, nym: sess.nymName ?? 'guest', code: sess.paymentCode, x, y, lastMove: 0, lastChat: 0 };
    this.players.set(id, p);

    const init: ServerMsg = {
      t: 'init', you: id,
      map: { w: MAP.w, h: MAP.h, blocked: [...MAP.blocked] },
      players: this.roster(),
      portals: this.portals.length ? this.portals : undefined,
      ssoToken: sess.ssoToken,
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
  }

  private move(p: Player, x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    if (x < 0 || y < 0 || x >= MAP.w || y >= MAP.h) return;
    if (MAP.blocked.has(x + ',' + y)) return;
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
  private pub(p: Player): PlayerState { return { id: p.id, nym: p.nym, code: p.code, x: p.x, y: p.y }; }
  private tick(): void { if (this.players.size) this.broadcast({ t: 'state', players: this.roster() }); }

  private broadcast(obj: ServerMsg, exceptId: number | null = null): void {
    const s = JSON.stringify(obj);
    for (const p of this.players.values())
      if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
  }

  private findSpawn(): [number, number] {
    for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++)
      if (!MAP.blocked.has(x + ',' + y) && ![...this.players.values()].some((q) => q.x === x && q.y === y))
        return [x, y];
    return [0, 0];
  }
}
