import type { ServerMsg, ClientMsg, PlayerState, Portal, Stall } from '../shared/protocol.ts';

const TILE_W = 64, TILE_H = 32, WALL_H = 56;
const WALK_MS = 320;
const STEP_SPEED = 1 / (WALK_MS / 1000);
const BUBBLE_MS = 6000;

// Sprite sheet constants
const SPRITE_W = 32, SPRITE_H = 48;
const SPRITE_FRAMES = 4;
const SPRITE_DIRS = 4; // 0=front, 1=back, 2=left, 3=right
const HEAD_SIZE = 16;
const HEAD_X = (SPRITE_W - HEAD_SIZE) / 2;
const HEAD_Y = 2;

const C = {
  bg: '#17121f', floorA: '#6b4f35', floorB: '#7d5c3e', floorEdge: '#5a4128',
  wallL: '#3b2d4a', wallR: '#4a3a5e', crate: '#8a6a45', crateDark: '#6b5136',
  hover: 'rgba(255,255,255,.18)', me: 'rgba(255,210,80,.8)',
};

const key = (x: number, y: number): string => x + ',' + y;
type InitMsg = Extract<ServerMsg, { t: 'init' }>;

interface Player extends PlayerState {
  img: HTMLImageElement;
  palette: string[];
  variant: SamuraiVariant;
  cutout: CutResult | null;
  sprite128: HTMLCanvasElement | null;
  sprite: HTMLCanvasElement | null;
  facing: number;
  tx: number; ty: number;
  rx: number; ry: number;
  path: [number, number][];
  nextStepAt: number;
  bubble: { text: string; until: number } | null;
}

// Magic colors in the sprite sheet that get replaced with Pepehash palette
const MAGIC: { r: number; g: number; b: number; pal: number }[] = [
  { r: 255, g: 0, b: 255, pal: 1 }, // magenta -> shirt
  { r: 0, g: 255, b: 255, pal: 2 }, // cyan -> pants
  { r: 255, g: 0, b: 0, pal: 0 },   // red -> skin
  { r: 255, g: 255, b: 0, pal: 3 }, // yellow -> accent
];

function parseColor(css: string): [number, number, number] {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  return [128, 128, 128];
}

type RGB = [number, number, number];

// --- Deterministic per-player variation (seeded from the broadcast avatar hash so
// every client renders a given player's samurai identically) ---
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(a: number): () => number {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SamuraiVariant { horn: number; trim: number; weapon: number; blunt: boolean }
function makeVariant(avatar: string): SamuraiVariant {
  const rng = mulberry32(hashStr(avatar || 'x'));
  return { horn: (rng() * 3) | 0, trim: (rng() * 2) | 0, weapon: (rng() * 3) | 0, blunt: rng() < 0.5 };
}

// --- Colorway helpers: map a player's PayNym palette onto samurai channels ---
const rgbCss = (c: RGB): string => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
const darken = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];
const lighten = (c: RGB, f: number): RGB => [c[0] + (255 - c[0]) * f, c[1] + (255 - c[1]) * f, c[2] + (255 - c[2]) * f];
const clampDark = (c: RGB, max: number): RGB => [Math.min(c[0], max), Math.min(c[1], max), Math.min(c[2], max)];
const satOf = (c: RGB): number => { const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]); return mx ? (mx - mn) / mx : 0; };

interface SamuraiColors { skin: RGB; clanA: RGB; clanB: RGB; armor: RGB; under: RGB; gold: RGB; boot: RGB; visor: RGB }
function samuraiColors(pal: string[]): SamuraiColors {
  const cols: RGB[] = (pal.length ? pal.map(parseColor) : [[210, 150, 70], [40, 40, 60], [60, 25, 25], [70, 70, 110]]) as RGB[];
  const skin = cols[0] ?? [210, 150, 70];
  // The two most-saturated avatar colors become the per-user "clan" colors.
  const bySat = cols.map((c, i) => [i, satOf(c)] as [number, number]).sort((a, b) => b[1] - a[1]);
  const clanA = cols[bySat[0]?.[0] ?? 0] ?? [150, 40, 40];
  const clanB = cols[bySat[1]?.[0] ?? 0] ?? lighten(clanA, 0.35);
  const armor = clampDark(darken(cols[1] ?? [50, 50, 65], 0.32), 64);   // near-black plates
  const under = clampDark(darken(clanA, 0.45), 90);                     // maroon-ish underlayer
  return { skin, clanA, clanB, armor, under, gold: [217, 164, 65], boot: [45, 32, 20], visor: [17, 17, 22] };
}

// --- Real-avatar rendering: isolate the paynym bust from its (per-avatar, possibly
// patterned) background, then extend it into a walking body. ---
export interface CutResult { cv: HTMLCanvasElement; minX: number; maxX: number; minY: number; maxY: number; shoulderMin: number; shoulderMax: number }

// Flood-fill the background inward from the borders by colour-similarity (bounded by the
// character's dark outline), then keep only the component at the centre so background
// islands (e.g. silhouette patterns) are dropped. Pure function of the avatar PNG →
// identical on every client. Returns null if the result is degenerate (→ caller falls back).
function cutout(img: HTMLImageElement): CutResult | null {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  if (!cx) return null;
  cx.imageSmoothingEnabled = false; cx.drawImage(img, 0, 0);
  let d: ImageData;
  try { d = cx.getImageData(0, 0, w, h); } catch { return null; } // tainted → bail
  const a = d.data, N = w * h;
  const S: number[][] = [];
  for (let x = 0; x < w; x += 8) { S.push([a[x * 4], a[x * 4 + 1], a[x * 4 + 2]]); const i = ((h - 1) * w + x) * 4; S.push([a[i], a[i + 1], a[i + 2]]); }
  for (let y = 0; y < h; y += 8) { let i = (y * w) * 4; S.push([a[i], a[i + 1], a[i + 2]]); i = (y * w + w - 1) * 4; S.push([a[i], a[i + 1], a[i + 2]]); }
  const TOL = 52 * 52;
  const mind = (i: number): number => {
    const r = a[i * 4], g = a[i * 4 + 1], b = a[i * 4 + 2]; let m = 1e9;
    for (const s of S) { const dr = r - s[0], dg = g - s[1], db = b - s[2]; const dd = dr * dr + dg * dg + db * db; if (dd < m) { m = dd; if (m < 64) break; } }
    return m;
  };
  const bg = new Uint8Array(N), st: number[] = [];
  const seed = (i: number): void => { if (!bg[i] && mind(i) < TOL) { bg[i] = 1; st.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (st.length) { const i = st.pop()!; const x = i % w, y = (i / w) | 0; if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (y > 0) seed(i - w); if (y < h - 1) seed(i + w); }
  // Keep the non-background component around the centre (drops background islands).
  const keep = new Uint8Array(N), ks: number[] = [];
  const y0 = (h * 0.46) | 0, y1 = (h * 0.54) | 0, x0 = (w * 0.46) | 0, x1 = (w * 0.54) | 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * w + x; if (!bg[i] && !keep[i]) { keep[i] = 1; ks.push(i); } }
  while (ks.length) {
    const i = ks.pop()!; const x = i % w, y = (i / w) | 0;
    if (x > 0 && !bg[i - 1] && !keep[i - 1]) { keep[i - 1] = 1; ks.push(i - 1); }
    if (x < w - 1 && !bg[i + 1] && !keep[i + 1]) { keep[i + 1] = 1; ks.push(i + 1); }
    if (y > 0 && !bg[i - w] && !keep[i - w]) { keep[i - w] = 1; ks.push(i - w); }
    if (y < h - 1 && !bg[i + w] && !keep[i + w]) { keep[i + w] = 1; ks.push(i + w); }
  }
  let kept = 0, minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep[y * w + x]) { kept++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (kept < N * 0.03 || kept > N * 0.97 || maxX <= minX || maxY <= minY) return null; // degenerate → fallback
  for (let i = 0; i < N; i++) if (!keep[i]) a[i * 4 + 3] = 0;
  cx.putImageData(d, 0, 0);
  let sMin = w, sMax = 0;
  for (let y = Math.max(0, maxY - 12); y <= maxY; y++) for (let x = 0; x < w; x++) if (keep[y * w + x]) { if (x < sMin) sMin = x; if (x > sMax) sMax = x; }
  return { cv, minX, maxX, minY, maxY, shoulderMin: sMin, shoulderMax: sMax };
}

// Bake a player's character into a fixed 128px-native pixel sprite: the extracted avatar
// bust downsampled into the grid + a samurai body drawn at the same grid, so bust and body
// share one pixel size and the whole thing reads as cohesive 128-bit pixel-art. Built once
// per player; deterministic (pure function of the avatar PNG).
const NAT_H = 128, BUST_H = 82;
function buildSprite128(cut: CutResult): HTMLCanvasElement | null {
  const cropW = cut.maxX - cut.minX, cropH = cut.maxY - cut.minY;
  if (cropW <= 0 || cropH <= 0) return null;
  const scale = BUST_H / cropH;
  const bustW = Math.max(1, Math.round(cropW * scale));
  const shoulder = Math.max(10, Math.round((cut.shoulderMax - cut.shoulderMin) * scale));
  const spriteW = Math.max(bustW, Math.round(shoulder * 1.45)) + 4;
  const cv = document.createElement('canvas'); cv.width = spriteW; cv.height = NAT_H;
  const g = cv.getContext('2d'); if (!g) return null;
  g.imageSmoothingEnabled = false;
  const midX = Math.round(spriteW / 2);

  // Armour colour sampled from the bust's lowest opaque rows (connects body to bust).
  let rr = 40, gg = 40, bb = 48;
  const bctx = cut.cv.getContext('2d');
  if (bctx) {
    const bd = bctx.getImageData(cut.shoulderMin, Math.max(0, cut.maxY - 6), Math.max(1, cut.shoulderMax - cut.shoulderMin), 6).data;
    let R = 0, G = 0, B = 0, n = 0;
    for (let i = 0; i < bd.length; i += 4) if (bd[i + 3] > 200) { R += bd[i]; G += bd[i + 1]; B += bd[i + 2]; n++; }
    if (n) { rr = R / n; gg = G / n; bb = B / n; }
  }
  const arm = `rgb(${rr | 0},${gg | 0},${bb | 0})`, dark = `rgb(${rr * 0.6 | 0},${gg * 0.6 | 0},${bb * 0.6 | 0})`, boot = `rgb(${rr * 0.5 | 0},${gg * 0.5 | 0},${bb * 0.5 | 0})`;
  const seam = `rgb(${Math.min(255, rr * 1.7) | 0},${Math.min(255, gg * 1.7) | 0},${Math.min(255, bb * 1.8) | 0})`;
  const GOLD = 'rgb(217,164,65)', LACE = '#2f45c8', LACED = '#1e2c86';
  const R = (x: number, y: number, w: number, h: number, c: string): void => { g.fillStyle = c; g.fillRect(Math.round(midX + x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); };

  // Body layout in native px (Habbo stature: big head, compact body).
  const ov = 8, torsoTop = BUST_H - ov, skirtTop = torsoTop + 10, skirtH = 24;
  const legTop = skirtTop + skirtH, legH = 12, bootTop = legTop + legH, bootH = NAT_H - bootTop;
  const hw = shoulder / 2;

  R(-hw, torsoTop, hw * 2, skirtTop - torsoTop + 2, arm);            // torso continuation
  const ROWS = 3;                                                    // kusazuri skirt
  for (let r = 0; r < ROWS; r++) {
    const t = skirtTop + (skirtH / ROWS) * r, wB = hw * (1 + (r + 1) * 0.12);
    R(-wB, t, wB * 2, skirtH / ROWS - 1, arm);
    g.fillStyle = seam; for (let k = -2; k <= 2; k++) g.fillRect(Math.round(midX + k * wB * 0.4), Math.round(t), 1, Math.round(skirtH / ROWS - 1));
    R(-wB, t + skirtH / ROWS - 2, wB * 2, 1.5, GOLD);
  }
  R(-hw * 0.24, skirtTop, hw * 0.48, skirtH, LACED);                 // front tasset
  for (let r = 0; r < 4; r++) R(-hw * 0.2, skirtTop + (skirtH / 4) * r + 1, hw * 0.4, 2.5, LACE);
  R(-hw * 0.62, legTop, hw * 0.5, legH, dark);                       // legs
  R(hw * 0.12, legTop, hw * 0.5, legH, dark);
  R(-hw * 0.7, bootTop, hw * 0.56, bootH, boot);                     // boots + gold toes
  R(hw * 0.14, bootTop, hw * 0.56, bootH, boot);
  R(-hw * 0.7, NAT_H - 2, hw * 0.56, 2, GOLD);
  R(hw * 0.14, NAT_H - 2, hw * 0.56, 2, GOLD);

  // The exact avatar bust, downsampled into the 128 grid → pixelated to match the body.
  g.imageSmoothingEnabled = false;
  g.drawImage(cut.cv, cut.minX, cut.minY, cropW, cropH, midX - bustW / 2, 0, bustW, BUST_H);
  return cv;
}

function extractPalette(img: HTMLImageElement): string[] {
  try {
    const c = document.createElement('canvas');
    c.width = 12; c.height = 12;
    const cx = c.getContext('2d')!;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(img, 0, 0, 12, 12);
    const data = cx.getImageData(0, 0, 12, 12).data;
    const counts = new Map<string, number>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 100) continue;
      const r = data[i] & 0xE0, g = data[i + 1] & 0xE0, b = data[i + 2] & 0xE0;
      const k = r + ',' + g + ',' + b;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k]) => {
        const p = k.split(',');
        return 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')';
      });
  } catch {
    return ['#c8b890', '#5a4a6a', '#3a3a4a', '#8a6a45'];
  }
}

// Create a personalized sprite canvas: palette-swapped body + Pepe head composited
function createPlayerSprite(img: HTMLImageElement, palette: string[], sheet: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_W * SPRITE_FRAMES;
  canvas.height = SPRITE_H * SPRITE_DIRS;
  const cx = canvas.getContext('2d')!;
  cx.imageSmoothingEnabled = false;

  // Draw the base sprite sheet
  cx.drawImage(sheet, 0, 0);

  // Palette swap: replace magic colors with Pepehash-derived palette
  const imageData = cx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 10) continue;
    for (const m of MAGIC) {
      if (data[i] === m.r && data[i + 1] === m.g && data[i + 2] === m.b) {
        const rgb = parseColor(palette[m.pal] || '#888888');
        data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
        break;
      }
    }
  }
  cx.putImageData(imageData, 0, 0);

  // Composite Pepe head onto front, left, right views (not back)
  for (let dir = 0; dir < SPRITE_DIRS; dir++) {
    if (dir === 1) continue; // skip back view
    for (let frame = 0; frame < SPRITE_FRAMES; frame++) {
      cx.drawImage(img,
        frame * SPRITE_W + HEAD_X, dir * SPRITE_H + HEAD_Y,
        HEAD_SIZE, HEAD_SIZE);
    }
  }

  return canvas;
}

export function bootRoom(ws: WebSocket, init: InitMsg): void {
  const canvas = document.getElementById('room-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const input = document.getElementById('chat-input') as HTMLInputElement;
  const log = document.getElementById('chat-log') as HTMLPreElement;

  const W = init.map.w, H = init.map.h;
  const blocked = new Set(init.map.blocked);
  const myId = init.you;
  const players = new Map<number, Player>();
  const portalMap = new Map<string, Portal>();
  if (init.portals) { for (const p of init.portals) portalMap.set(p.tile, p); }

  const stallMap = new Map<string, Stall>();
  if (init.stalls) { for (const s of init.stalls) stallMap.set(s.tile, s); }

  // Load character sprite sheet (optional — falls back to procedural if missing)
  var spriteSheet: HTMLImageElement | null = null;
  (function loadSheet() {
    var ss = new Image();
    ss.onload = function() {
      spriteSheet = ss;
      console.log('[engine] sprite sheet loaded');
      for (var p of players.values()) {
        if (p.img.complete && p.img.naturalWidth) {
          p.sprite = createPlayerSprite(p.img, p.palette, ss);
        }
      }
    };
    ss.onerror = function() { console.log('[engine] no sprite sheet — using procedural characters'); };
    ss.src = '/assets/character-base.png';
  })();

  const send = (m: ClientMsg): void => ws.send(JSON.stringify(m));

  function addPlayer(p: PlayerState): void {
    const img = new Image();
    const player: Player = {
      ...p, img, palette: ['#c8b890', '#5a4a6a', '#3a3a4a', '#8a6a45'],
      variant: makeVariant(p.avatar),
      cutout: null, sprite128: null, sprite: null, facing: 0,
      tx: p.x, ty: p.y, rx: p.x, ry: p.y,
      path: [], nextStepAt: 0, bubble: null,
    };
    img.onload = function() {
      player.palette = extractPalette(img);
      player.cutout = cutout(img);   // isolate the real avatar → bake into a 128-bit sprite
      player.sprite128 = player.cutout ? buildSprite128(player.cutout) : null;
      if (spriteSheet) {
        player.sprite = createPlayerSprite(img, player.palette, spriteSheet);
      }
    };
    img.src = '/api/avatar/' + p.avatar;
    players.set(p.id, player);
  }
  init.players.forEach(addPlayer);

  ws.onmessage = (ev: MessageEvent) => {
    const m = JSON.parse(ev.data as string) as ServerMsg;
    if (m.t === 'join') addPlayer(m.player);
    else if (m.t === 'sso') openPortal(m.dest, m.token);
    else if (m.t === 'leave') players.delete(m.id);
    else if (m.t === 'chat') {
      const p = players.get(m.id);
      if (p) p.bubble = { text: m.text, until: performance.now() + BUBBLE_MS };
      log.textContent += '+' + m.nym + ': ' + m.text + '\n';
      const lines = log.textContent.split('\n');
      if (lines.length > 200) log.textContent = lines.slice(-200).join('\n');
      log.scrollTop = log.scrollHeight;
    }
    else if (m.t === 'state') {
      for (const s of m.players) {
        if (s.id === myId) continue;
        const p = players.get(s.id);
        if (p) { p.tx = s.x; p.ty = s.y; }
      }
    }
  };

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && input.value.trim()) {
      send({ t: 'chat', text: input.value.trim() });
      input.value = '';
    }
  });

  let ox = 0, oy = 0;
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ox = canvas.clientWidth / 2;
    oy = canvas.clientHeight / 2 - ((W + H) * TILE_H / 4) + WALL_H / 2;
  }
  window.addEventListener('resize', resize);
  resize();

  const toScreen = (x: number, y: number): [number, number] =>
    [ox + (x - y) * TILE_W / 2, oy + (x + y) * TILE_H / 2];
  const corner = (cx: number, cy: number): [number, number] =>
    [ox + (cx - cy) * TILE_W / 2, oy + (cx + cy) * TILE_H / 2 - TILE_H / 2];
  const toTile = (px: number, py: number): [number, number] => {
    const dx = (px - ox) / (TILE_W / 2), dy = (py - oy) / (TILE_H / 2);
    return [Math.floor((dy + dx) / 2), Math.floor((dy - dx) / 2)];
  };

  let hover: [number, number] | null = null;
  canvas.addEventListener('mousemove', (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const [x, y] = toTile(e.clientX - r.left, e.clientY - r.top);
    hover = (x >= 0 && y >= 0 && x < W && y < H) ? [x, y] : null;
  });

  canvas.addEventListener('click', () => {
    if (!hover) return;
    const tk = key(hover[0], hover[1]);
    if (portalMap.has(tk)) {
      var portal = portalMap.get(tk)!;
      // Ask our server for a destination-bound SSO token, then open the peer's onion.
      if (portal.onion) send({ t: 'portal', dest: portal.onion });
      return;
    }
    if (stallMap.has(tk)) { showWares(stallMap.get(tk)!); return; }
    var me = players.get(myId);
    if (!me || blocked.has(tk)) return;
    var path = findPath(Math.round(me.rx), Math.round(me.ry), hover[0], hover[1]);
    if (path?.length) { me.path = path; me.nextStepAt = 0; }
  });

  function openPortal(dest: string, token: string): void {
    window.open('http://' + dest + '/?sso=' + encodeURIComponent(token) + '&room=vendor', '_blank');
  }

  // --- Wares panel (DOM overlay) ---
  var waresEl: HTMLDivElement | null = null;
  function showWares(stall: Stall): void {
    if (!waresEl) {
      waresEl = document.createElement('div');
      waresEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' +
        'background:#1d1628;border:1px solid #3b2d4a;color:#eee;font-family:monospace;font-size:12px;' +
        'padding:1rem;max-width:340px;width:80%;max-height:70vh;overflow-y:auto;z-index:10;box-shadow:0 8px 40px rgba(0,0,0,.6)';
      document.getElementById('room')!.appendChild(waresEl);
    }
    var rows = stall.wares.map(function (w) {
      var price = w.priceSats != null ? (' — ' + w.priceSats.toLocaleString() + ' sats') : '';
      return '<div style="padding:.35rem 0;border-top:1px solid #2a2038">' +
        '<b>' + esc(w.name) + '</b>' + price +
        (w.desc ? '<div style="opacity:.7">' + esc(w.desc) + '</div>' : '') + '</div>';
    }).join('');
    waresEl.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<b style="color:#ffd870">' + esc(stall.name) + '</b>' +
      '<span id="wares-x" style="cursor:pointer;opacity:.7">✕</span></div>' +
      rows +
      '<div style="margin-top:.75rem;opacity:.7">pay with your wallet (BIP47):</div>' +
      (stall.qr ? '<img src="' + stall.qr + '" width="180" style="display:block;margin:.4rem auto;image-rendering:pixelated">' : '') +
      '<div style="word-break:break-all;font-size:10px;background:#0e0a14;padding:.4rem">' + esc(stall.payCode) + '</div>';
    waresEl.hidden = false;
    (document.getElementById('wares-x') as HTMLElement).onclick = function () { waresEl!.hidden = true; };
  }
  function esc(s: string): string {
    return s.replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]; });
  }

  function findPath(sx: number, sy: number, gx: number, gy: number): [number, number][] | null {
    const open: [number, number][] = [[sx, sy]];
    const came = new Map<string, string>(), g = new Map<string, number>([[key(sx, sy), 0]]);
    const h = (x: number, y: number): number => Math.abs(gx - x) + Math.abs(gy - y);
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++)
        if (g.get(key(...open[i]))! + h(...open[i]) < g.get(key(...open[bi]))! + h(...open[bi])) bi = i;
      const [cx, cy] = open.splice(bi, 1)[0];
      if (cx === gx && cy === gy) {
        const path: [number, number][] = [];
        let k = key(gx, gy);
        while (came.has(k)) { path.unshift(k.split(',').map(Number) as [number, number]); k = came.get(k)!; }
        return path;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || blocked.has(key(nx, ny))) continue;
        const ng = g.get(key(cx, cy))! + 1;
        if (ng < (g.get(key(nx, ny)) ?? Infinity)) {
          g.set(key(nx, ny), ng); came.set(key(nx, ny), key(cx, cy));
          if (!open.some(([x, y]) => x === nx && y === ny)) open.push([nx, ny]);
        }
      }
    }
    return null;
  }

  function step(now: number, dt: number): void {
    var me = players.get(myId);
    if (me?.path.length && now >= me.nextStepAt) {
      var [nx, ny] = me.path.shift()!;
      me.tx = nx; me.ty = ny; me.nextStepAt = now + WALK_MS;
      send({ t: 'move', x: nx, y: ny });
    }
    for (var p of players.values()) {
      var dx = p.tx - p.rx, dy = p.ty - p.ry;
      var dist = Math.hypot(dx, dy);
      if (dist > 0.001) { var mv = Math.min(dist, STEP_SPEED * dt); p.rx += dx / dist * mv; p.ry += dy / dist * mv; }
    }
  }

  const rr = (x: number, y: number, w: number, h: number, r: number): void => {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };
  const diamond = (cx: number, cy: number, fill: string): void => {
    ctx.fillStyle = fill; ctx.beginPath();
    ctx.moveTo(cx, cy - TILE_H / 2); ctx.lineTo(cx + TILE_W / 2, cy);
    ctx.lineTo(cx, cy + TILE_H / 2); ctx.lineTo(cx - TILE_W / 2, cy);
    ctx.closePath(); ctx.fill();
  };

  function drawWalls(): void {
    var [ax, ay] = corner(0, 0), [lx, ly] = corner(0, H), [rx, ry] = corner(W, 0);
    ctx.fillStyle = C.wallL; ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(lx, ly); ctx.lineTo(lx, ly - WALL_H); ctx.lineTo(ax, ay - WALL_H);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.wallR; ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(rx, ry); ctx.lineTo(rx, ry - WALL_H); ctx.lineTo(ax, ay - WALL_H);
    ctx.closePath(); ctx.fill();
  }

  function drawFloor(): void {
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var [sx, sy] = toScreen(x, y);
      diamond(sx, sy, (x + y) % 2 ? C.floorA : C.floorB);
      if (hover?.[0] === x && hover?.[1] === y && !blocked.has(key(x, y))) diamond(sx, sy, C.hover);
    }
  }

  function drawCrate(x: number, y: number): void {
    var [cx, cy] = toScreen(x, y); var BH = 22;
    diamond(cx, cy - BH, C.crate);
    ctx.fillStyle = C.crateDark; ctx.beginPath();
    ctx.moveTo(cx - TILE_W / 2, cy - BH); ctx.lineTo(cx, cy - BH + TILE_H / 2);
    ctx.lineTo(cx, cy + TILE_H / 2); ctx.lineTo(cx - TILE_W / 2, cy);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.floorEdge; ctx.beginPath();
    ctx.moveTo(cx + TILE_W / 2, cy - BH); ctx.lineTo(cx, cy - BH + TILE_H / 2);
    ctx.lineTo(cx, cy + TILE_H / 2); ctx.lineTo(cx + TILE_W / 2, cy);
    ctx.closePath(); ctx.fill();
  }

  function drawPortal(x: number, y: number, portal: Portal): void {
    var [cx, cy] = toScreen(x, y); var doorH = 42;
    ctx.fillStyle = '#1a0e2a'; ctx.fillRect(cx - 13, cy - doorH + 6, 26, doorH);
    ctx.fillStyle = '#3a2a5a'; ctx.fillRect(cx - 10, cy - doorH + 10, 20, doorH - 6);
    var grad = ctx.createLinearGradient(cx, cy - doorH + 10, cx, cy + 6);
    grad.addColorStop(0, 'rgba(255,200,80,.25)'); grad.addColorStop(1, 'rgba(255,200,80,0)');
    ctx.fillStyle = grad; ctx.fillRect(cx - 10, cy - doorH + 10, 20, doorH - 6);
    ctx.fillStyle = '#1a0e2a'; ctx.beginPath(); ctx.arc(cx, cy - doorH + 10, 13, Math.PI, 0); ctx.fill();
    ctx.font = '9px monospace'; ctx.fillStyle = '#ffd870'; ctx.textAlign = 'center';
    ctx.fillText(portal.name, cx, cy - doorH - 2); ctx.textAlign = 'left';
  }

  function drawStall(x: number, y: number, stall: Stall): void {
    var [cx, cy] = toScreen(x, y); var BH = 16;
    // Table top
    diamond(cx, cy - BH, C.crate);
    ctx.fillStyle = C.crateDark; ctx.beginPath();
    ctx.moveTo(cx - TILE_W / 2, cy - BH); ctx.lineTo(cx, cy - BH + TILE_H / 2);
    ctx.lineTo(cx, cy + TILE_H / 2); ctx.lineTo(cx - TILE_W / 2, cy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.floorEdge; ctx.beginPath();
    ctx.moveTo(cx + TILE_W / 2, cy - BH); ctx.lineTo(cx, cy - BH + TILE_H / 2);
    ctx.lineTo(cx, cy + TILE_H / 2); ctx.lineTo(cx + TILE_W / 2, cy); ctx.closePath(); ctx.fill();
    // Striped awning
    var awnY = cy - BH - 30;
    for (var i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? '#c0392b' : '#ecf0f1';
      ctx.fillRect(cx - 22 + i * 11, awnY, 11, 10);
    }
    ctx.fillStyle = '#7a2018'; ctx.fillRect(cx - 22, awnY + 10, 44, 3);
    // Goods bumps on the table
    ctx.fillStyle = '#caa15a';
    ctx.beginPath(); ctx.arc(cx - 8, cy - BH - 2, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 6, cy - BH - 1, 3, 0, Math.PI * 2); ctx.fill();
    // Label
    ctx.font = '9px monospace'; ctx.fillStyle = '#ffd870'; ctx.textAlign = 'center';
    ctx.fillText(stall.name, cx, awnY - 3); ctx.textAlign = 'left';
  }

  function drawPlayer(p: Player, now: number): void {
    var [sx, sy] = toScreen(p.rx, p.ry);
    var moving = Math.hypot(p.tx - p.rx, p.ty - p.ry) > 0.01;
    var walkFrame = moving ? Math.floor(now / 150) % SPRITE_FRAMES : 0;
    var bob = moving ? [0, -1, 0, -1][walkFrame] : 0;

    // Determine facing direction
    if (moving) {
      var dx = p.tx - p.rx, dy = p.ty - p.ry;
      if (Math.abs(dy) > Math.abs(dx)) p.facing = dy > 0 ? 0 : 1;
      else p.facing = dx > 0 ? 3 : 2;
    }
    var dir = p.facing;

    var feetY = sy + 6;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.beginPath(); ctx.ellipse(sx, feetY, 12, 5, 0, 0, Math.PI * 2); ctx.fill();

    // Me ring
    if (p.id === myId) {
      ctx.strokeStyle = C.me; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(sx, feetY, 14, 6, 0, 0, Math.PI * 2); ctx.stroke();
    }

    if (p.sprite128) {
      // --- 128-bit pixel sprite: pixelated avatar bust + matching pixel body ---
      const spr = p.sprite128, dispH = 96, sc = dispH / spr.height, dispW = spr.width * sc;
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      if (dir === 2) { ctx.translate(sx * 2, 0); ctx.scale(-1, 1); }
      ctx.drawImage(spr, Math.round(sx - dispW / 2), Math.round(feetY - dispH + bob), Math.round(dispW), Math.round(dispH));
      ctx.restore();
    } else if (p.sprite) {
      // --- Sprite sheet mode ---
      ctx.imageSmoothingEnabled = false;
      var frameX = walkFrame * SPRITE_W;
      var frameY = dir * SPRITE_H;
      ctx.drawImage(p.sprite, frameX, frameY, SPRITE_W, SPRITE_H,
        sx - SPRITE_W / 2, feetY - SPRITE_H + bob, SPRITE_W, SPRITE_H);
    } else {
      // --- Procedural samurai-Pepe fallback (until the avatar image loads) ---
      drawSamurai(p, sx, feetY, bob, walkFrame, moving);
    }

    // Name tag
    var top = feetY - 44 + bob;
    ctx.font = '10px monospace';
    var nameText = '+' + p.nym;
    var tw = ctx.measureText(nameText).width;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    rr(sx - tw / 2 - 4, top - 14, tw + 8, 12, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.fillText(nameText, sx, top - 5);

    // Chat bubble
    if (p.bubble && now < p.bubble.until) {
      var text = p.bubble.text.length > 60 ? p.bubble.text.slice(0, 60) + '...' : p.bubble.text;
      var bw = ctx.measureText(text).width + 14, bh = 16;
      var bx = sx - bw / 2, by = top - 14 - bh - 6;
      ctx.fillStyle = '#fff'; rr(bx, by, bw, bh, 5); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx - 4, by + bh); ctx.lineTo(sx + 4, by + bh); ctx.lineTo(sx, by + bh + 5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#000'; ctx.font = '10px monospace'; ctx.fillText(text, sx, by + 12);
    }
    ctx.textAlign = 'left';
  }

  // Procedural samurai-Pepe. Colorway comes from the player's PayNym palette and the
  // structural variant from the avatar hash, so every client draws a given player the same.
  function drawSamurai(p: Player, sx: number, feetY: number, bob: number, walkFrame: number, moving: boolean): void {
    const back = p.facing === 1;
    const v = p.variant;
    const col = samuraiColors(p.palette);
    const ub = bob;
    const legOff = moving ? [0, 1, 0, 1][walkFrame] : 0;
    const A = rgbCss(col.armor), U = rgbCss(col.under), CA = rgbCss(col.clanA), CB = rgbCss(col.clanB),
      SK = rgbCss(col.skin), GD = rgbCss(col.gold), BT = rgbCss(col.boot), VZ = rgbCss(col.visor);
    ctx.imageSmoothingEnabled = false;
    const R = (x: number, y: number, w: number, h: number, c: string): void => {
      ctx.fillStyle = c; ctx.fillRect(Math.round(sx + x), Math.round(feetY + y), w, h);
    };
    const tri = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: string): void => {
      ctx.fillStyle = c; ctx.beginPath();
      ctx.moveTo(sx + x1, feetY + y1); ctx.lineTo(sx + x2, feetY + y2); ctx.lineTo(sx + x3, feetY + y3);
      ctx.closePath(); ctx.fill();
    };

    // Boots + gold toes
    R(-8, -5, 7, 5, BT); R(1, -5 + legOff, 7, 5, BT);
    if (!back) { R(-8, -2, 3, 2, GD); R(5, -2 + legOff, 3, 2, GD); }
    // Greaves (shin armor, maroon)
    R(-7, -13, 5, 8, U); R(2, -13 + legOff, 5, 8, U);

    // Kusazuri (lamellar skirt) — trapezoid with clan lacing rows
    ctx.fillStyle = A; ctx.beginPath();
    ctx.moveTo(sx - 9, feetY - 22 + ub); ctx.lineTo(sx + 9, feetY - 22 + ub);
    ctx.lineTo(sx + 11, feetY - 11); ctx.lineTo(sx - 11, feetY - 11); ctx.closePath(); ctx.fill();
    R(-10, -19 + ub, 20, 1, CB); R(-10, -15 + ub, 20, 1, CB);
    R(-11, -13, 2, 2, U); R(9, -13, 2, 2, U);

    // Far shoulder guard (behind torso, for depth)
    R(8, -33 + ub, 6, 11, A); R(8, -33 + ub, 6, 2, CA);

    // Torso (do) with plate highlight + maroon underlayer at the sides
    R(-9, -34 + ub, 18, 13, A);
    R(-9, -34 + ub, 18, 1, rgbCss(lighten(col.armor, 0.25)));
    R(-9, -24 + ub, 2, 3, U); R(7, -24 + ub, 2, 3, U);

    if (back) {
      R(-5, -33 + ub, 1, 11, CB); R(0, -33 + ub, 1, 11, CB); R(4, -33 + ub, 1, 11, CB);
    } else {
      R(-1, -33 + ub, 2, 9, CB);   // chest cord
      R(-4, -25 + ub, 8, 3, CB);   // sash band
      R(-2, -24 + ub, 4, 4, CB);   // sash knot
    }

    // Near shoulder guard + orange hands
    R(-14, -33 + ub, 6, 11, A); R(-14, -33 + ub, 6, 2, CA);
    R(-13, -22 + ub, 3, 5, SK); R(10, -22 + ub, 3, 5, SK);

    // Weapon (hash-picked)
    if (v.weapon === 0) {
      if (back) { // katana sheathed across the back
        ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(sx - 8, feetY - 30 + ub); ctx.lineTo(sx + 9, feetY - 14 + ub); ctx.stroke();
      } else { // katana held low
        ctx.strokeStyle = '#c9ccd1'; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(sx - 12, feetY - 20 + ub); ctx.lineTo(sx - 22, feetY - 2 + ub); ctx.stroke();
        R(-13, -22 + ub, 3, 2, GD); // tsuba
      }
    } else if (v.weapon === 1) { // naginata
      ctx.strokeStyle = '#6b4a2a'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(sx + 12, feetY - 30 + ub); ctx.lineTo(sx + 14, feetY - 2 + ub); ctx.stroke();
      tri(12, -30 + ub, 18, -34 + ub, 13, -26 + ub, '#c9ccd1');
    }

    // Kabuto dome + neck flare + ridge
    ctx.fillStyle = A; ctx.beginPath(); ctx.ellipse(sx, feetY - 38 + ub, 9, 7, 0, Math.PI, 0); ctx.fill();
    R(-9, -38 + ub, 18, 4, A);
    R(-1, -45 + ub, 2, 7, rgbCss(lighten(col.armor, 0.2)));

    // Horns (clanA) — hash-picked style
    if (v.horn === 0) { // straight spikes
      tri(-8, -44 + ub, -6, -53 + ub, -4, -44 + ub, CA);
      tri(4, -44 + ub, 6, -53 + ub, 8, -44 + ub, CA);
    } else if (v.horn === 1) { // kuwagata crescents
      R(-9, -50 + ub, 3, 7, CA); R(-9, -51 + ub, 6, 2, CA);
      R(6, -50 + ub, 3, 7, CA); R(3, -51 + ub, 6, 2, CA);
    } else { // forked antlers
      tri(-7, -44 + ub, -8, -52 + ub, -5, -45 + ub, CA); tri(-8, -52 + ub, -11, -50 + ub, -7, -49 + ub, CA);
      tri(7, -44 + ub, 8, -52 + ub, 5, -45 + ub, CA); tri(8, -52 + ub, 11, -50 + ub, 7, -49 + ub, CA);
    }

    // Maedate crest disc for some trims (front)
    if (!back && v.trim === 1) {
      ctx.fillStyle = CA; ctx.beginPath(); ctx.arc(sx, feetY - 40 + ub, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = GD; ctx.beginPath(); ctx.arc(sx, feetY - 40 + ub, 1.3, 0, Math.PI * 2); ctx.fill();
    }

    if (back) {
      R(-8, -36 + ub, 16, 3, rgbCss(darken(col.armor, 0.8)));
      ctx.fillStyle = CB;
      for (let i = -6; i <= 6; i += 3) { ctx.beginPath(); ctx.arc(sx + i, feetY - 35 + ub, 1.2, 0, Math.PI * 2); ctx.fill(); }
    } else {
      // Orange snout + black VR visor
      R(-5, -36 + ub, 10, 4, SK);
      R(-4, -33 + ub, 8, 1, rgbCss(darken(col.skin, 0.7)));
      R(-7, -41 + ub, 14, 5, VZ);
      R(-7, -41 + ub, 14, 1, 'rgba(255,255,255,.6)');
      ctx.fillStyle = CB;
      for (let j = -5; j <= 5; j += 2.5) { ctx.beginPath(); ctx.arc(sx + j, feetY - 31 + ub, 1.1, 0, Math.PI * 2); ctx.fill(); }
      // Flourish: the actual PayNym avatar shown on the visor screen
      if (p.img.complete && p.img.naturalWidth) {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(p.img, Math.round(sx - 6), Math.round(feetY - 41 + ub), 12, 5);
        ctx.globalAlpha = 1;
      }
      // Striped blunt (hash-picked)
      if (v.blunt) {
        for (let b = 0; b < 5; b++) R(6 + b * 2, -35 + ub, 2, 2, b % 2 ? '#c0392b' : '#ecf0f1');
        ctx.fillStyle = 'rgba(220,220,220,.5)'; ctx.beginPath(); ctx.arc(sx + 18, feetY - 36 + ub, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function render(now: number): void {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawWalls(); drawFloor();
    var drawables: { s: number; f: () => void }[] = [];
    for (const k of blocked) {
      const [x, y] = k.split(',').map(Number);
      if (portalMap.has(k)) { const portal = portalMap.get(k)!; drawables.push({ s: x + y, f: () => drawPortal(x, y, portal) }); }
      else if (stallMap.has(k)) { const stall = stallMap.get(k)!; drawables.push({ s: x + y, f: () => drawStall(x, y, stall) }); }
      else { drawables.push({ s: x + y, f: () => drawCrate(x, y) }); }
    }
    for (const p of players.values()) drawables.push({ s: p.rx + p.ry + 0.5, f: () => drawPlayer(p, now) });
    drawables.sort((a, b) => a.s - b.s);
    for (var d of drawables) d.f();
  }

  var last = performance.now();
  (function loop(now: number): void {
    var dt = Math.min(0.1, (now - last) / 1000); last = now;
    step(now, dt); render(now);
    requestAnimationFrame(loop);
  })(last);
}
