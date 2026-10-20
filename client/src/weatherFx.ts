// Weather drawn on the floor: rain (a scrolling pattern clipped to the open sky), fog (one cached radial sprite that
// follows your character), rain through open windows. Everything is cheap by construction: rain is a handful of
// pattern fills over the outdoor rooms that are in view, fog is a single drawImage, and nothing allocates per frame.
import type { Rect, TileMap } from '../../shared/map';
import { FOG_CLEAR, FOG_FULL, FOG_MAX_ALPHA, OUTDOOR_ROOMS } from '../../shared/weather';

const TS = 16;
type View = { x0: number; y0: number; x1: number; y1: number };
/** Rain tile: a few slanted streaks on a transparent square that repeats; scrolled along the slant to fall. */
const RAIN_SIZE = 64;
const SLANT = 0.33; // pixels left per pixel down

function rainTile(streaks: number, alpha: number, seed: number) {
  const c = document.createElement('canvas'); c.width = c.height = RAIN_SIZE;
  const g = c.getContext('2d')!;
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  g.fillStyle = `rgba(205,225,245,${alpha})`;
  for (let i = 0; i < streaks; i++) {
    const x = Math.floor(rnd() * RAIN_SIZE), y = Math.floor(rnd() * RAIN_SIZE), len = 5 + Math.floor(rnd() * 5);
    for (let k = 0; k < len; k++) g.fillRect(((x - Math.round(k * SLANT)) % RAIN_SIZE + RAIN_SIZE) % RAIN_SIZE, (y + k) % RAIN_SIZE, 1, 1);
  }
  return c;
}

/** A tileable cloud of fog: three octaves of value noise, posterised into soft pixel-art steps, white-grey with varying alpha. */
const FOG_SIZE = 128;
function fogTile(seed: number, scale: number) {
  const c = document.createElement('canvas'); c.width = c.height = FOG_SIZE;
  const g = c.getContext('2d')!, img = g.createImageData(FOG_SIZE, FOG_SIZE);
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const lattice = (n: number) => Array.from({ length: n * n }, rnd);
  const octaves = [[4, 0.55], [8, 0.3], [16, 0.15]].map(([n, w]) => ({ n, w, v: lattice(n) }));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const sample = (o: { n: number; v: number[] }, x: number, y: number) => {
    const fx = (x / FOG_SIZE) * o.n, fy = (y / FOG_SIZE) * o.n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0);
    const at = (i: number, j: number) => o.v[(((j % o.n) + o.n) % o.n) * o.n + (((i % o.n) + o.n) % o.n)];
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  };
  for (let y = 0; y < FOG_SIZE; y++) for (let x = 0; x < FOG_SIZE; x++) {
    const bx = x - (x % scale), by = y - (y % scale); // chunky pixels
    let v = 0; for (const o of octaves) v += sample(o, bx, by) * o.w;
    const level = Math.floor(Math.max(0, Math.min(0.999, (v - 0.25) / 0.6)) * 5) / 4; // 5 steps
    const i = (y * FOG_SIZE + x) * 4;
    img.data[i] = 226; img.data[i + 1] = 232; img.data[i + 2] = 238; img.data[i + 3] = Math.round(level * 150);
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class WeatherFx {
  /** Open sky, in pixels: the outdoor rooms. */
  readonly sky: Rect[];
  private near: CanvasPattern | null = null; private far: CanvasPattern | null = null; private pane: CanvasPattern | null = null; private clouds: CanvasPattern[] = [];
  private fogSprite: HTMLCanvasElement | null = null;
  private skyPath: Path2D | null = null;
  constructor(map: TileMap) {
    this.sky = map.rooms.filter(r => OUTDOOR_ROOMS.has(r.id)).map(r => ({ x: r.rect.x * TS, y: r.rect.y * TS, w: r.rect.w * TS, h: r.rect.h * TS }));
  }

  /** Does any open sky show in `view` (world pixels)? */
  skyInView(v: View) {
    return this.sky.some(r => r.x < v.x1 && r.x + r.w > v.x0 && r.y < v.y1 && r.y + r.h > v.y0);
  }

  /** Rain over the open sky in view. `ms` is the animation clock: hold it still to pause the rain. */
  drawRain(ctx: CanvasRenderingContext2D, v: View, ms: number) {
    this.near ??= ctx.createPattern(rainTile(26, 0.6, 7), 'repeat');
    this.far ??= ctx.createPattern(rainTile(30, 0.3, 91), 'repeat');
    if (!this.near || !this.far) return;
    ctx.save();
    for (const [pat, speed] of [[this.far, 0.17], [this.near, 0.31]] as const) {
      const oy = (ms * speed) % RAIN_SIZE, ox = -oy * SLANT;
      ctx.fillStyle = pat;
      for (const r of this.sky) {
        const x0 = Math.max(r.x, v.x0), y0 = Math.max(r.y, v.y0), x1 = Math.min(r.x + r.w, v.x1), y1 = Math.min(r.y + r.h, v.y1);
        if (x1 <= x0 || y1 <= y0) continue;
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
        ctx.translate(ox, oy); ctx.fillRect(x0 - ox, y0 - oy, x1 - x0, y1 - y0);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** Rain falling past an open window: only the glass area (x, y, w, h in world pixels). */
  drawWindowRain(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ms: number) {
    this.pane ??= ctx.createPattern(rainTile(110, 0.8, 13), 'repeat'); // a window is small: a denser sheet so it always reads as rain
    if (!this.pane) return;
    const oy = (ms * 0.2) % RAIN_SIZE, ox = -oy * SLANT;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = 'rgba(70,90,110,0.45)'; ctx.fillRect(x, y, w, h); // a grey sky behind it
    ctx.translate(ox, oy); ctx.fillStyle = this.pane; ctx.fillRect(x - ox, y - oy, w, h);
    ctx.restore();
  }

  /**
   * Fog over the open sky around `cx, cy` (world pixels, usually your character): clear within FOG_CLEAR tiles, thickening
   * to FOG_MAX_ALPHA at FOG_FULL, then flat. One cached radial sprite plus four rectangles for the rest.
   */
  drawFog(ctx: CanvasRenderingContext2D, v: View, cx: number, cy: number, ms: number) {
    const R = FOG_FULL * TS, S = 2 * R;
    if (!this.fogSprite) {
      const c = this.fogSprite = document.createElement('canvas'); c.width = c.height = S;
      const g = c.getContext('2d')!, gr = g.createRadialGradient(R, R, FOG_CLEAR * TS, R, R, R);
      gr.addColorStop(0, 'rgba(196,206,214,0)'); gr.addColorStop(0.5, `rgba(196,206,214,${FOG_MAX_ALPHA * 0.4})`); gr.addColorStop(1, `rgba(196,206,214,${FOG_MAX_ALPHA})`);
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
    const x = Math.round(cx - R), y = Math.round(cy - R);
    if (!this.skyPath) { this.skyPath = new Path2D(); for (const r of this.sky) this.skyPath.rect(r.x, r.y, r.w, r.h); }
    ctx.save(); ctx.clip(this.skyPath);
    ctx.drawImage(this.fogSprite, x, y);
    ctx.fillStyle = `rgba(196,206,214,${FOG_MAX_ALPHA})`;
    ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, y - v.y0); // above
    ctx.fillRect(v.x0, y + S, v.x1 - v.x0, v.y1 - y - S); // below
    ctx.fillRect(v.x0, y, x - v.x0, S); // left
    ctx.fillRect(x + S, y, v.x1 - x - S, S); // right
    // drifting banks of fog over all of it: two clouds sliding past each other, thicker where the haze already is
    if (!this.clouds.length) for (const [seed, scale] of [[5, 4], [77, 2]]) { const p = ctx.createPattern(fogTile(seed, scale), 'repeat'); if (p) this.clouds.push(p); }
    this.clouds.forEach((pat, i) => {
      const dx = (ms * (0.006 + i * 0.004)) % FOG_SIZE, dy = (ms * 0.002 * (i + 1)) % FOG_SIZE;
      ctx.save(); ctx.translate(-dx, dy * (i ? -1 : 1)); ctx.fillStyle = pat; ctx.globalAlpha = i ? 0.55 : 0.8;
      ctx.fillRect(v.x0 + dx, v.y0 - dy * (i ? -1 : 1), v.x1 - v.x0, v.y1 - v.y0);
      ctx.restore();
    });
    ctx.restore();
  }
}
