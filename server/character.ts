import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Generates each player's 128-bit character sprite on the SERVER: the extracted avatar bust
// on the shared reference body, recolored to the avatar's clan colour. Tor Browser blocks
// client-side `getImageData` (anti-fingerprinting), so this must not run in the browser —
// the client just draws the PNG this produces. Ported verbatim from the client pipeline.

interface CutResult { cv: Canvas; minX: number; maxX: number; minY: number; maxY: number; shoulderMin: number; shoulderMax: number }
type RGB = [number, number, number];

function parseColor(css: string): RGB {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  return [128, 128, 128];
}

// Flood-fill the background inward from the borders by colour-similarity (bounded by the
// character's dark outline), then keep only the component at the centre so background
// islands (e.g. patterned backgrounds) are dropped.
function cutout(img: Image | Canvas): CutResult | null {
  const w = img.width, h = img.height;
  if (!w || !h) return null;
  const cv = createCanvas(w, h);
  const cx = cv.getContext('2d');
  cx.imageSmoothingEnabled = false; cx.drawImage(img as unknown as Image, 0, 0);
  const d = cx.getImageData(0, 0, w, h);
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
  if (kept < N * 0.03 || kept > N * 0.97 || maxX <= minX || maxY <= minY) return null;
  for (let i = 0; i < N; i++) if (!keep[i]) a[i * 4 + 3] = 0;
  cx.putImageData(d, 0, 0);
  let sMin = w, sMax = 0;
  for (let y = Math.max(0, maxY - 12); y <= maxY; y++) for (let x = 0; x < w; x++) if (keep[y * w + x]) { if (x < sMin) sMin = x; if (x > sMax) sMax = x; }
  return { cv, minX, maxX, minY, maxY, shoulderMin: sMin, shoulderMax: sMax };
}

function pickClan(pal: string[]): RGB {
  let best: RGB = [47, 69, 200], bs = -1;
  for (const c of pal) { const rgb = parseColor(c); const mx = Math.max(...rgb), mn = Math.min(...rgb); const s = mx ? (mx - mn) / mx : 0; if (s > bs) { bs = s; best = rgb; } }
  return best;
}

function extractPalette(img: Image): string[] {
  const c = createCanvas(12, 12); const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false; cx.drawImage(img, 0, 0, 12, 12);
  const data = cx.getImageData(0, 0, 12, 12).data;
  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 100) continue;
    const r = data[i] & 0xE0, g = data[i + 1] & 0xE0, b = data[i + 2] & 0xE0;
    counts.set(r + ',' + g + ',' + b, (counts.get(r + ',' + g + ',' + b) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => { const p = k.split(','); return 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')'; });
}

const SPR_H = 150, SHOULDER_Y = 0.50;
function buildSprite128(cut: CutResult, palette: string[], bodyClean: CutResult): Canvas {
  const src = bodyClean.cv, sw = src.width, sh = src.height;
  const scale = SPR_H / sh, W = Math.round(sw * scale), H = SPR_H;
  const cv = createCanvas(W, H);
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src as unknown as Image, 0, 0, sw, sh, 0, 0, W, H);

  const clan = pickClan(palette);
  const clanLum = Math.max(1, 0.3 * clan[0] + 0.59 * clan[1] + 0.11 * clan[2]);
  const d = g.getImageData(0, 0, W, H), a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 30) continue;
    const r = a[i], gr = a[i + 1], b = a[i + 2], mx = Math.max(r, gr, b), mn = Math.min(r, gr, b);
    if (b > r + 22 && b > gr + 18 && mx - mn > 40) {
      const f = (0.3 * r + 0.59 * gr + 0.11 * b) / clanLum;
      a[i] = Math.min(255, clan[0] * f); a[i + 1] = Math.min(255, clan[1] * f); a[i + 2] = Math.min(255, clan[2] * f);
    }
  }
  g.putImageData(d, 0, 0);

  const shoulderY = Math.round(H * SHOULDER_Y);
  let cxSum = 0, cxN = 0;
  for (let y = shoulderY; y < H; y++) for (let x = 0; x < W; x++) if (a[(y * W + x) * 4 + 3] > 40) { cxSum += x; cxN++; }
  const bodyCX = cxN ? cxSum / cxN : W / 2;
  g.clearRect(0, 0, W, shoulderY);

  const cropW = cut.maxX - cut.minX, cropH = cut.maxY - cut.minY;
  let shW = cropW;
  const bc2 = cut.cv.getContext('2d');
  const ys = Math.round(cut.minY + cropH * 0.55), rows = Math.max(1, cut.maxY - ys);
  const bd = bc2.getImageData(cut.minX, ys, cropW, rows).data;
  let widest = 0;
  for (let ry = 0; ry < rows; ry++) { let x1 = cropW, x2 = 0; for (let rx = 0; rx < cropW; rx++) if (bd[(ry * cropW + rx) * 4 + 3] > 60) { if (rx < x1) x1 = rx; if (rx > x2) x2 = rx; } if (x2 - x1 > widest) widest = x2 - x1; }
  if (widest > 10) shW = widest;
  const s = (W * 0.56) / shW;
  const bustW = cropW * s, bustH = cropH * s;
  const destX = bodyCX - (cropW / 2) * s;
  const destY = shoulderY + Math.round(H * 0.05) - bustH;
  g.imageSmoothingEnabled = false;
  g.drawImage(cut.cv as unknown as Image, cut.minX, cut.minY, cropW, cropH, destX, destY, bustW, bustH);
  return cv;
}

export class CharacterService {
  private cacheDir: string;
  private bodyPath: string;
  private bodyClean: CutResult | null = null;
  private mem = new Map<string, Buffer>();

  constructor(opts: { cacheDir: string; bodyPath: string }) {
    this.cacheDir = opts.cacheDir;
    this.bodyPath = opts.bodyPath;
  }

  async init(): Promise<void> {
    try {
      const bimg = await loadImage(this.bodyPath);
      this.bodyClean = cutout(bimg);
      console.log('[character] reference body', this.bodyClean ? 'ready' : 'cutout failed');
    } catch (e) {
      console.log('[character] no reference body:', (e as Error).message);
    }
  }

  // Build (or read cached) the character sprite PNG for an avatar id. `avatarFile` is the
  // cached avatar PNG path (must already exist — the caller pre-warms it).
  async build(avatarId: string, avatarFile: string): Promise<Buffer | null> {
    const cached = this.mem.get(avatarId);
    if (cached) return cached;
    const file = path.join(this.cacheDir, avatarId + '.png');
    try { const b = await readFile(file); this.mem.set(avatarId, b); return b; } catch { /* build below */ }
    if (!this.bodyClean) return null;
    let img: Image;
    try { img = await loadImage(avatarFile); } catch { return null; }
    const cut = cutout(img);
    if (!cut) return null;
    const png = buildSprite128(cut, extractPalette(img), this.bodyClean).toBuffer('image/png');
    this.mem.set(avatarId, png);
    try { await mkdir(this.cacheDir, { recursive: true }); await writeFile(file, png); } catch { /* best effort */ }
    return png;
  }
}
