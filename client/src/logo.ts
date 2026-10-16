// The top-bar logo show. A crew of three people from the office (their pixel avatars at half size, so they are as
// tall as the letters) walks in along the bar's bottom edge and tosses "The Deck" together bit by bit, bottom row
// first. Ta-da: they hop, the letters wave, a glint runs across. They walk off and the logo rests for a minute or so
// (nothing is drawn then). Then a stripe of code rain sweeps through, the bits glitch green, drop and fade, a cursor
// blinks and the next crew builds it again. Quiet on purpose: no sound, slow pace, long rests.
// Everything on screen is a pure function of (layout, seed, time into the cycle): makePlan + walkerAt / bitAt, tested
// in logo.test.ts. LogoShow only measures the DOM text, rasterizes it and paints frames.
import type { Look } from '../../shared/protocol';
import type { Assets } from './assets';
import { drawText } from './font';

export const BIT = 2;                 // css px: the logo goes together in 2×2 bits
const SPRITE = 0.5;                   // css px per art pixel
const SW = 8, SH = 12;                // a crew member on screen, css px (16×24 art at half size)
const HANDS = 7;                      // css px above the floor: where tossed bits start
export const BOOT = 1600;             // the cursor blinks this long before the crew walks in
const WALK = 32;                      // css px/s: the floor's walking pace at half size
const TURN = 200, TOSS_EVERY = 260, HANDFUL = 4, SPREAD = 45, FLIGHT = 560, ARC = 6;
const TADA_WAIT = 300, TADA = 2200, HOP = 420, HOP_H = 4, EXIT_GAP = 300;
const SWEEP = 26, FLASH = 220, GRAVITY = 260, FADE = 500, LIE = 250;
const REST = 60_000, REST_JITTER = 30_000;
const PAD_L = 10, PAD_R = 56;         // canvas beyond the text: the bar's left padding, the empty bar to the right
const CODE = '01<>/=+#';

export interface Bit { sx: number; sy: number; x: number; y: number; letter: number } // sx/sy: device px in the raster; x/y: css
export interface Layout {
  w: number; h: number; floor: number;                          // canvas, css px; the floor is the bar's bottom border
  letters: { x: number; w: number }[];                          // ink-bearing characters, left to right
  bits: Bit[];
  ink: { x0: number; x1: number; y0: number; y1: number };
  cursor: { x: number; y: number };
}
type Dir = 'down' | 'left' | 'right' | 'up';
type Act = 'walk' | 'idle' | 'toss' | 'hop';
interface Seg { t0: number; t1: number; x0: number; x1: number; dir: Dir; act: Act }
export interface Walker { segs: Seg[]; letters: number[] }
interface Toss { at: number; land: number; fx: number; fy: number }
interface Fall { hit: number; drop: number; vx: number; ground: number; bounce: number; end: number }
export interface Plan {
  walkers: Walker[]; tosses: Toss[]; falls: Fall[]; sparkles: { x: number; y: number; at: number }[];
  firstLand: number; buildEnd: number; tada: number; exitEnd: number; code: number; end: number;
  sweep: { x0: number; x1: number; t0: number; t1: number };
}
export interface Pose { x: number; dy: number; dir: Dir; frame: number; alpha: number }
export interface BitPose { x: number; y: number; state: 'off' | 'fly' | 'set' | 'hit' | 'fall'; alpha: number }

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Splits letters (by their bit counts) into `k` contiguous groups of about the same work. */
export function split(counts: number[], crew: number): number[][] {
  const n = counts.length, k = Math.max(1, Math.min(crew, n)), total = counts.reduce((a, c) => a + c, 0), starts = [0];
  let acc = 0;
  for (let i = 0, j = 1; i < n && j < k; i++) {
    const before = acc; acc += counts[i];
    while (j < k && acc >= total * j / k) {
      const target = total * j / k, at = target - before < counts[i] / 2 ? i : i + 1; // cut on the nearer side of letter i
      starts.push(clamp(at, starts[starts.length - 1] + 1, n - (k - j)));
      j++;
    }
  }
  while (starts.length < k) starts.push(starts[starts.length - 1] + 1);
  return starts.map((s, g) => Array.from({ length: (starts[g + 1] ?? n) - s }, (_, i) => s + i));
}

export function makePlan(L: Layout, seed: number, crew = 3): Plan {
  const rnd = rng(seed);
  const rest = REST + rnd() * REST_JITTER;
  const byLetter = L.letters.map((_, li) => L.bits.flatMap((b, j) => b.letter === li ? [j] : []));
  const groups = split(byLetter.map(b => b.length), crew);
  const tosses: Toss[] = L.bits.map(() => ({ at: 0, land: 0, fx: 0, fy: 0 }));
  const sides: number[] = [];
  const walkers: Walker[] = groups.map((group, gi) => {
    // the first crew member comes from the left and works rightwards; the others come from the right, farthest first
    const side = gi === 0 && groups.length > 1 ? -1 : 1;
    sides.push(side);
    const order = side < 0 ? group : [...group].reverse();
    let t = side < 0 ? BOOT + 300 : BOOT + Math.max(0, gi - 1) * 700, x = side < 0 ? -SW : L.w + SW;
    const segs: Seg[] = [];
    const go = (to: number) => {
      const dt = Math.abs(to - x) / WALK * 1000;
      if (dt > 1) segs.push({ t0: t, t1: t + dt, x0: x, x1: to, dir: to < x ? 'left' : 'right', act: 'walk' });
      t += dt; x = to;
    };
    for (const li of order) {
      const l = L.letters[li];
      go(Math.round(l.x + l.w / 2));
      segs.push({ t0: t, t1: t + TURN, x0: x, x1: x, dir: 'up', act: 'idle' }); t += TURN;
      // bottom row first, any order within a row, a handful at a time
      const queue = byLetter[li].map(j => ({ j, k: -Math.round(L.bits[j].y) * 1000 + rnd() * 999 })).sort((a, b) => a.k - b.k);
      queue.forEach(({ j }, n) => {
        const at = t + Math.floor(n / HANDFUL) * TOSS_EVERY + (n % HANDFUL) * SPREAD;
        tosses[j] = { at, land: at + FLIGHT + (rnd() - 0.5) * 120, fx: x + (rnd() - 0.5) * 3, fy: L.floor - HANDS };
      });
      const dt = Math.ceil(queue.length / HANDFUL) * TOSS_EVERY;
      segs.push({ t0: t, t1: t + dt, x0: x, x1: x, dir: 'up', act: 'toss' }); t += dt;
    }
    return { segs, letters: order };
  });
  const lands = tosses.map(s => s.land);
  const buildEnd = Math.max(BOOT, ...lands), tada = buildEnd + TADA_WAIT;
  // done: face the room, hop at the ta-da, then leave the way they came, one after another
  walkers.forEach((w, i) => {
    const last = w.segs[w.segs.length - 1];
    let t = last?.t1 ?? tada, x = last?.x1 ?? L.w + SW;
    const leave = tada + TADA + i * EXIT_GAP, out = sides[i] < 0 ? -SW : L.w + SW;
    if (tada > t) w.segs.push({ t0: t, t1: tada, x0: x, x1: x, dir: 'down', act: 'idle' });
    w.segs.push({ t0: tada, t1: tada + TADA, x0: x, x1: x, dir: 'down', act: 'hop' });
    if (leave > tada + TADA) w.segs.push({ t0: tada + TADA, t1: leave, x0: x, x1: x, dir: 'down', act: 'idle' });
    t = leave;
    w.segs.push({ t0: t, t1: t + Math.abs(out - x) / WALK * 1000, x0: x, x1: out, dir: out < x ? 'left' : 'right', act: 'walk' });
  });
  const exitEnd = Math.max(...walkers.map(w => w.segs[w.segs.length - 1].t1), tada + TADA);
  const code = exitEnd + rest;
  const sweep = { x0: L.ink.x0 - 10, x1: L.ink.x1 + 10, t0: code, t1: 0 };
  sweep.t1 = code + (sweep.x1 - sweep.x0) / SWEEP * 1000;
  const g = GRAVITY / 1e6; // css px per ms²
  const falls: Fall[] = L.bits.map(b => {
    const hit = sweep.t0 + (b.x + BIT / 2 - sweep.x0) / (sweep.x1 - sweep.x0) * (sweep.t1 - sweep.t0) + rnd() * 120;
    const drop = hit + FLASH + rnd() * 160;
    const ground = Math.sqrt(2 * Math.max(0, L.floor - BIT - b.y) / g);
    const bounce = 2 * 0.3 * ground; // up and down again at 30% of the landing speed
    return { hit, drop, vx: (rnd() - 0.5) * 0.016, ground, bounce, end: drop + ground + bounce + LIE + FADE };
  });
  const end = Math.max(sweep.t1 + 300, ...falls.map(f => f.end)) + 400;
  const sparkles = Array.from({ length: 4 }, (_, i) => ({
    x: Math.round(L.ink.x0 + rnd() * (L.ink.x1 - L.ink.x0)), y: Math.round(L.ink.y0 - 3 + rnd() * (L.ink.y1 - L.ink.y0 + 4)),
    at: tada + 250 + i * 260 + rnd() * 100,
  }));
  return { walkers, tosses, falls, sparkles, firstLand: Math.min(Infinity, ...lands), buildEnd, tada, exitEnd, code, end, sweep };
}

/** Where crew member `i` is at `t`, or null when off stage. */
export function walkerAt(p: Plan, L: Layout, i: number, t: number): Pose | null {
  const s = p.walkers[i]?.segs.find(s => t >= s.t0 && t < s.t1);
  if (!s) return null;
  const x = s.x0 + (s.x1 - s.x0) * (t - s.t0) / (s.t1 - s.t0);
  let frame = 0, dy = 0;
  if (s.act === 'walk') { frame = 1 + Math.floor(t / 125) % 4; dy = frame % 2 ? 0 : -SPRITE; }
  else if (s.act === 'toss') dy = (t - s.t0) % TOSS_EVERY < 110 ? -SPRITE : 0;
  else if (s.act === 'hop') {
    const h = t - s.t0 - i * 130;
    if (h >= 0 && h < 2 * HOP) { const v = (h % HOP) / HOP; dy = -HOP_H * 4 * v * (1 - v); }
  }
  return { x, dy, dir: s.dir, frame, alpha: clamp((L.w - 4 - x) / 16) }; // fades in and out at the canvas's right edge
}

/** Letter wave during the ta-da, css px. */
export function waveAt(p: Plan, letter: number, t: number) {
  const u = (t - p.tada - 250 - letter * 70) / 280;
  return u > 0 && u < 1 ? -2 * Math.sin(Math.PI * u) : 0;
}

/** Where bit `i` is at `t`. */
export function bitAt(p: Plan, L: Layout, i: number, t: number): BitPose {
  const b = L.bits[i];
  if (t < p.code) {
    const s = p.tosses[i];
    if (t < s.at) return { x: b.x, y: b.y, state: 'off', alpha: 0 };
    if (t < s.land) { // a lob: up past the spot and down into it
      const u = (t - s.at) / (s.land - s.at), x0 = s.fx - BIT / 2, y0 = s.fy - BIT / 2;
      return { x: x0 + (b.x - x0) * u, y: y0 + (b.y - y0) * u - ARC * 4 * u * (1 - u), state: 'fly', alpha: 1 };
    }
    return { x: b.x, y: b.y + waveAt(p, b.letter, t), state: 'set', alpha: 1 };
  }
  const f = p.falls[i];
  if (t < f.hit) return { x: b.x, y: b.y, state: 'set', alpha: 1 };
  if (t < f.drop) return { x: b.x + (Math.floor((t - f.hit) / 70) % 2 ? SPRITE : -SPRITE), y: b.y, state: 'hit', alpha: 1 };
  if (t >= f.end) return { x: b.x, y: b.y, state: 'off', alpha: 0 };
  const g = GRAVITY / 1e6, dt = t - f.drop, ground = L.floor - BIT;
  const x = b.x + f.vx * Math.min(dt, f.ground + f.bounce);
  let y = ground;
  if (dt < f.ground) y = b.y + 0.5 * g * dt * dt;
  else if (dt < f.ground + f.bounce) { const v = 0.3 * g * f.ground, d = dt - f.ground; y = ground - (v * d - 0.5 * g * d * d); }
  return { x, y: Math.min(y, ground), state: 'fall', alpha: clamp((f.end - t) / FADE) };
}

/** The code stripe's leading edge at `t`, with its opacity, or null outside the sweep. */
export function sweepAt(p: Plan, t: number) {
  const s = p.sweep;
  if (t < s.t0 || t >= s.t1 + 300) return null;
  const u = (t - s.t0) / (s.t1 - s.t0);
  return { x: s.x0 + (s.x1 - s.x0) * Math.min(u, 1), alpha: clamp((t - s.t0) / 300) * clamp((s.t1 + 300 - t) / 300) };
}

const DIR_ROW: Record<Dir, number> = { down: 0, left: 1, right: 2, up: 3 };
// stand-ins when fewer than three people are in: colors from the appearance picker
const EXTRAS: Look[] = [
  ['#f2c79b', '#2b1d1f', '#b4534a', '#3d3a52', 0], ['#a46a43', '#d8a050', '#4f9a92', '#2c3e5a', 2],
  ['#e2ad7f', '#b4473a', '#d0a040', '#5a4030', 1], ['#c98d5e', '#4f2b1a', '#8a5aa0', '#4a4a4a', 3],
].map(([skin, hair, shirt, pants, style]) => ({
  skin, hair, shirt, pants, eyes: '#2b1d1f', shoes: '#4a3028', glassesColor: '#2b1d1f', hatColor: '#b4534a',
  style: style as number, top: 0, bottom: 0, glasses: 0, hat: 0, beard: 0, mustache: 0,
} as Look));
const hash = (n: number) => { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; return (Math.imul(h, 0xc2b2ae35) ^ (h >>> 16)) >>> 0; };

/** Runs the show on a canvas laid over the brand text. */
export class LogoShow {
  private ctx: CanvasRenderingContext2D;
  private layout: Layout | null = null;
  private src: HTMLCanvasElement | null = null;   // the logo, rasterized exactly as the page draws it
  private green: HTMLCanvasElement | null = null; // the same, glitched
  private plan: Plan | null = null;
  private start: number | null = null;            // when this cycle started (performance.now); null: waiting for sprites
  private seed = (Math.random() * 2 ** 31) | 0;
  private looks: Look[] = [];
  private assets: Assets | null = null;
  private raf = 0;
  private timer = 0;
  private dpr = 1;
  private accent = '#f2b45a';
  private code = '#7cc87c';
  private ro: ResizeObserver;
  private mq: MediaQueryList | null = null;

  constructor(private text: HTMLElement, private canvas: HTMLCanvasElement, private crew: () => Look[]) {
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.relayout());
    this.ro.observe(text);
    const bar = text.closest('.topbar');
    if (bar) this.ro.observe(bar);
    document.addEventListener('visibilitychange', this.onVisible);
    this.watchDpr();
    this.relayout();
    if (import.meta.env.DEV) Object.assign(window, { __deckLogo: this });
  }

  destroy() {
    this.stop();
    this.ro.disconnect();
    this.mq?.removeEventListener('change', this.onDpr);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.text.classList.remove('brand-drawn');
  }

  setAssets(assets: Assets | null) {
    this.assets = assets;
    if (assets && this.start === null && !document.hidden) this.begin(performance.now());
    this.kick();
  }

  /** Dev/test: jump to `ms` into the current cycle. */
  seek(ms: number) {
    if (this.start === null) this.begin(performance.now());
    this.start = performance.now() - ms;
    this.stop(); this.kick();
  }
  get state() { return { plan: this.plan, layout: this.layout, t: this.start === null ? null : performance.now() - this.start }; }

  private begin(now: number) {
    this.start = now;
    this.seed = (this.seed + 0x9e3779b9) | 0;
    const rnd = rng(this.seed);
    const pick = (list: Look[]) => list.map(l => ({ l, k: rnd() })).sort((a, b) => a.k - b.k).map(x => x.l);
    this.looks = [...pick(this.crew()), ...pick(EXTRAS)].slice(0, 3);
    this.plan = this.layout ? makePlan(this.layout, this.seed) : null;
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    this.raf = this.timer = 0;
  }

  private kick() {
    if (!this.raf && !this.timer && !document.hidden && this.layout) this.raf = requestAnimationFrame(this.frame);
  }

  private onVisible = () => {
    if (document.hidden) return this.stop();
    const now = performance.now();
    if (this.start === null) { if (this.assets) this.begin(now); }
    else if (this.plan) { // back from another tab: never mid-show, and the next show is at least 20 s away
      const p = this.plan, t = now - this.start;
      this.start = now - clamp(t, p.exitEnd, p.code - 20_000);
    }
    this.kick();
  };

  private watchDpr() {
    this.mq?.removeEventListener('change', this.onDpr);
    this.mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.mq.addEventListener('change', this.onDpr);
  }
  private onDpr = () => { this.watchDpr(); this.relayout(); };

  private relayout() {
    this.layout = this.measure();
    this.text.classList.toggle('brand-drawn', !!this.layout);
    if (!this.layout) return this.stop();
    if (this.start !== null) this.plan = makePlan(this.layout, this.seed);
    this.stop(); this.kick();
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.layout || document.hidden) return;
    if (this.start === null || !this.plan) { this.paint(null, now); this.raf = requestAnimationFrame(this.frame); return; }
    if (now - this.start >= this.plan.end) this.begin(now);
    const p = this.plan!, t = now - this.start!;
    this.paint(t, now);
    // the rest: nothing moves, so no frames until the code comes
    if (t >= p.exitEnd && t < p.code) this.timer = window.setTimeout(() => { this.timer = 0; this.kick(); }, p.code - t);
    else this.raf = requestAnimationFrame(this.frame);
  };

  /** Measures the brand text and rasterizes it, glyph by glyph where the page put each one. */
  private measure(): Layout | null {
    const el = this.text, bar = el.closest<HTMLElement>('.topbar'), node = el.firstChild;
    if (!bar || !(node instanceof Text)) return null;
    const r = el.getBoundingClientRect(), br = bar.getBoundingClientRect();
    if (r.width < 1 || bar.clientHeight < 1) return null;
    const d = this.dpr = window.devicePixelRatio || 1;
    const root = getComputedStyle(document.documentElement);
    this.accent = root.getPropertyValue('--accent').trim() || this.accent;
    this.code = root.getPropertyValue('--accent2').trim() || this.code;
    // down to the bar's bottom border: the crew stands on it, shoes on the line
    const ox = r.left - PAD_L, oy = br.top, w = Math.ceil(r.width) + PAD_L + PAD_R, h = Math.ceil(br.height), floor = bar.clientHeight + 1;
    const cv = this.canvas;
    Object.assign(cv.style, { left: `${-PAD_L}px`, top: `${oy - r.top}px`, width: `${w}px`, height: `${h}px` });
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    const src = document.createElement('canvas');
    src.width = cv.width; src.height = cv.height;
    const sc = src.getContext('2d', { willReadFrequently: true })!;
    const cs = getComputedStyle(el);
    sc.scale(d, d);
    sc.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    sc.fillStyle = this.accent;
    const letters: Layout['letters'] = [], range = document.createRange();
    let cursor: Layout['cursor'] | null = null;
    for (let i = 0; i < node.data.length; i++) {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const cr = range.getBoundingClientRect(), ch = node.data[i];
      const m = sc.measureText(ch), x = cr.left - ox, base = cr.top - oy + (m.fontBoundingBoxAscent ?? cr.height * 0.8);
      cursor ??= { x, y: base + 1 };
      if (!ch.trim()) continue;
      sc.fillText(ch, x, base);
      letters.push({ x, w: cr.width });
    }
    const px = sc.getImageData(0, 0, src.width, src.height).data, W = src.width, H = src.height;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0 || !cursor || !letters.length) return null;
    const B = Math.max(1, Math.round(BIT * d)), bits: Bit[] = [];
    for (let sy = y0; sy <= y1; sy += B) for (let sx = x0; sx <= x1; sx += B) {
      let ink = false;
      for (let y = sy; y < Math.min(sy + B, H) && !ink; y++) for (let x = sx; x < Math.min(sx + B, W); x++) if (px[(y * W + x) * 4 + 3]) { ink = true; break; }
      if (!ink) continue;
      const cx = (sx + B / 2) / d;
      let letter = 0, best = Infinity;
      letters.forEach((l, li) => { const dist = Math.abs(l.x + l.w / 2 - cx); if (dist < best) { best = dist; letter = li; } });
      bits.push({ sx, sy, x: sx / d, y: sy / d, letter });
    }
    const green = document.createElement('canvas');
    green.width = W; green.height = H;
    const gc = green.getContext('2d')!;
    gc.drawImage(src, 0, 0); gc.globalCompositeOperation = 'source-in'; gc.fillStyle = this.code; gc.fillRect(0, 0, W, H);
    this.src = src; this.green = green;
    return { w, h, floor, letters, bits, ink: { x0: x0 / d, x1: (x1 + 1) / d, y0: y0 / d, y1: (y1 + 1) / d }, cursor };
  }

  private paint(t: number | null, now: number) {
    const L = this.layout!, ctx = this.ctx, d = this.dpr, src = this.src!, green = this.green!;
    const at = (v: number) => Math.round(v * d);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const cursor = (ms: number) => {
      if (Math.floor(ms / 530) % 2) return;
      ctx.fillStyle = this.accent;
      ctx.fillRect(at(L.cursor.x), at(L.cursor.y), at(7), at(2));
    };
    if (t === null || !this.plan) return cursor(now);
    const p = this.plan;
    if (t >= p.exitEnd && t < p.code) { ctx.drawImage(src, 0, 0); return; }
    if (t < p.firstLand && t < p.code) cursor(t);
    const B = Math.max(1, Math.round(BIT * d)), flying: BitPose[] = [], flyingBits: Bit[] = [];
    L.bits.forEach((b, i) => {
      const s = bitAt(p, L, i, t);
      if (s.state === 'off') return;
      if (s.state === 'fly') { flying.push(s); flyingBits.push(b); return; }
      ctx.globalAlpha = s.alpha;
      ctx.drawImage(s.state === 'set' ? src : green, b.sx, b.sy, B, B, at(s.x), at(s.y), B, B);
    });
    ctx.globalAlpha = 1;
    // ta-da: a glint runs across the letters (drawn onto the letters only)
    const g = t - p.tada - 700;
    if (g >= 0 && g < 800) {
      const gx = L.ink.x0 - 8 + (L.ink.x1 - L.ink.x0 + 16) * g / 800;
      const grad = ctx.createLinearGradient(at(gx - 4), at(L.ink.y1), at(gx + 4), at(L.ink.y0));
      grad.addColorStop(0, 'rgba(255,248,225,0)'); grad.addColorStop(0.5, 'rgba(255,248,225,0.8)'); grad.addColorStop(1, 'rgba(255,248,225,0)');
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = grad;
      ctx.fillRect(at(L.ink.x0 - 2), at(L.ink.y0 - 3), at(L.ink.x1 - L.ink.x0 + 4), at(L.ink.y1 - L.ink.y0 + 6));
      ctx.globalCompositeOperation = 'source-over';
    }
    if (this.assets && t < p.code) {
      const c = this.assets.atlas.character;
      ctx.imageSmoothingEnabled = d * SPRITE < 1; // crisp on Retina; a soft half-size sprite at 1×
      p.walkers.forEach((_, i) => {
        const w = walkerAt(p, L, i, t), look = this.looks[i % this.looks.length];
        if (!w || !look || w.alpha <= 0) return;
        ctx.globalAlpha = w.alpha;
        ctx.drawImage(this.assets!.sheet(look), w.frame * c.frameW, DIR_ROW[w.dir] * c.frameH, c.frameW, c.frameH,
          at(w.x - SW / 2), at(L.floor - SH + w.dy), at(SW), at(SH));
      });
      ctx.globalAlpha = 1;
    }
    flying.forEach((s, n) => ctx.drawImage(src, flyingBits[n].sx, flyingBits[n].sy, B, B, at(s.x), at(s.y), B, B));
    // ta-da sparkles
    ctx.fillStyle = '#fff1c9';
    for (const s of p.sparkles) {
      const u = (t - s.at) / 600;
      if (u < 0 || u >= 1) continue;
      const r = Math.round(2 * Math.sin(Math.PI * u));
      ctx.fillRect(at(s.x), at(s.y), at(1), at(1));
      for (let k = 1; k <= r; k++) for (const [dx, dy] of [[k, 0], [-k, 0], [0, k], [0, -k]]) ctx.fillRect(at(s.x + dx), at(s.y + dy), at(1), at(1));
    }
    // the code: three columns of falling glyphs, the leading one brightest
    const sw = sweepAt(p, t);
    if (sw) {
      ctx.setTransform(d, 0, 0, d, 0, 0);
      const fall = (t - p.sweep.t0) * 0.045;
      for (let col = 0; col < 3; col++) {
        const cx = Math.round(sw.x) - col * 4;
        for (let k = -1; k <= Math.ceil(L.h / 6); k++) {
          const y = Math.round(((fall + col * 2) % 6) + k * 6);
          const edge = clamp(y / 6) * clamp((L.h - 5 - y) / 6);
          const h = hash(col * 977 + (k - Math.floor((fall + col * 2) / 6)) * 31 + Math.floor((t - p.sweep.t0) / 120) * 7919);
          ctx.globalAlpha = sw.alpha * edge * [0.95, 0.6, 0.3][col] * (0.6 + 0.4 * (h % 100) / 100);
          if (ctx.globalAlpha > 0.02) drawText(ctx, CODE[h % CODE.length], cx, y, col ? this.code : '#d4f5d0');
        }
      }
      ctx.globalAlpha = 1;
    }
  }
}
