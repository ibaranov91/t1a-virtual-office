// How each effect looks on a person: one entry per effect kind, all optional.
// look: palette tweaks on the character sheet; sway: a motion offset for the whole sprite;
// back: drawn before the body (auras, capes); front: after it (hats, particles, critters).
import type { Effect, Look } from '../../shared/protocol';
import type { Pose } from './net';
import { SPECIAL_HATS, danceBeat } from '../../shared/effects';

export interface FxCtx {
  ctx: CanvasRenderingContext2D;
  x: number; top: number; baseY: number; // sprite's left edge, top of its 16×24 frame (bob included), feet line
  ms: number; seed: number; p: Pose; e: Effect;
  blit(name: string, x: number, y: number): void;
  has(name: string): boolean;
}
interface FxDraw {
  look?(look: Look, e: Effect): Look;
  sway?(ms: number, seed: number, p: Pose, e: Effect): { dx: number; rot: number; dy?: number };
  back?(c: FxCtx): void;
  front?(c: FxCtx): void;
}

const flip = (ms: number, period: number, seed = 0) => 1 + Math.floor((ms + seed * 97) / period) % 2;

/** Particles drifting up and around someone: n of them, each looping every `period` ms. */
function rising(c: FxCtx, frame: (i: number) => string, n: number, period: number, spread: number, height: number) {
  const { ctx } = c;
  for (let i = 0; i < n; i++) {
    const k = ((c.ms + c.seed * 131 + i * period / n) % period) / period;
    ctx.globalAlpha = Math.min(1, (1 - k) * 1.6);
    const dx = Math.round(Math.sin(i * 2.4 + k * 5) * spread);
    c.blit(frame(i), c.x + 8 + dx - 2, c.baseY - 4 - Math.round(k * height));
  }
  ctx.globalAlpha = 1;
}

export const EFFECT_DRAW: Record<string, FxDraw> = {
  dance: { // two frames on the 120 BPM beat: sway one way with the left arm up, then the other with the right
    sway: (ms, _seed, p) => p.walking ? { dx: 0, rot: 0 } : { dx: danceBeat(Date.now()) % 2 ? 1 : -1, rot: danceBeat(Date.now()) % 2 ? 0.07 : -0.07 },
    front(c) {
      if (c.p.walking) return;
      const left = danceBeat(Date.now()) % 2 === 0, ax = left ? c.x + 1 : c.x + 13;
      c.ctx.fillStyle = '#f0c8a0'; c.ctx.fillRect(ax, c.top + 6, 2, 5); // the raised arm
      c.ctx.fillStyle = left ? '#ff5ec8' : '#5ef0ff'; c.ctx.fillRect(ax, c.top + 4, 2, 2); // glow stick
    },
  },
  speed: { // a quick blur of yellow streaks trailing behind
    back(c) {
      if (!c.p.walking) return rising(c, () => 'sparkle_2', 2, 1400, 7, 10);
      const [dx, dy] = ({ left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] } as Record<string, number[]>)[c.p.dir] ?? [0, 0];
      c.ctx.fillStyle = 'rgba(248,224,112,0.75)';
      for (let i = 0; i < 3; i++) {
        const len = 3 + ((c.ms / 60 + i * 2) % 4), y = c.baseY - 6 - i * 4;
        if (dx) c.ctx.fillRect(dx > 0 ? c.x + 12 + i : c.x + 4 - len - i, y, len, 1);
        else c.ctx.fillRect(c.x + 4 + i * 4, dy > 0 ? c.baseY - 2 + i : c.top + 2 - len, 1, len);
      }
    },
  },
  hat: {
    look: (l, e) => ({ ...l, hat: 0, ...ODYSSEY[String(e.data?.style)]?.look }), // instead of the everyday cap or bowler; the Odyssey hats also dress you
    sway: (ms, _seed, p, e) => String(e.data?.style) === 'winged' ? { dx: 0, rot: 0, dy: p.walking ? -4 : -3 + Math.round(Math.sin(ms / 380)) } : { dx: 0, rot: 0 }, // Hermes hovers
    back(c) { ODYSSEY[String(c.e.data?.style)]?.back?.(c); },
    front(c) {
      const style = String(c.e.data?.style ?? 'top'), name = `hat_${style}`;
      if (!c.has(name)) return;
      const h = HAT_H[style] ?? 10;
      ODYSSEY[style]?.beforeHat?.(c);
      c.blit(name, c.x, c.top + 4 - h);
      ODYSSEY[style]?.front?.(c);
      if (style === 'judge' || style === 'laurel') for (let i = 0; i < 4; i++) { // a ring of twinkles around the hat
        const k = ((c.ms / 1600 + i / 4) % 1) * Math.PI * 2;
        c.ctx.globalAlpha = 0.6 + 0.4 * Math.sin(c.ms / 150 + i);
        c.blit(`sparkle_${flip(c.ms, 220, i)}`, c.x + 6 + Math.round(Math.cos(k) * 10), c.top - 4 - h / 2 + Math.round(Math.sin(k) * 5));
      }
      c.ctx.globalAlpha = 1;
    },
  },
  vampire: {
    look: l => ({ ...l, skin: '#dcdcec', shirt: '#1e1a26', pants: '#141218', shoes: '#141218', hair: '#141018', eyes: '#c8303a' }),
    back(c) { if (c.p.dir !== 'up') c.blit('cape', c.x + 1 + (c.p.dir === 'left' ? 2 : c.p.dir === 'right' ? -2 : 0), c.top + 10); },
    front(c) {
      if (c.p.dir === 'up') c.blit('cape', c.x + 1, c.top + 10);
      for (let i = 0; i < 2; i++) { // bats circling overhead
        const k = (c.ms / 1800 + i / 2) % 1 * Math.PI * 2;
        c.blit(`bat_${flip(c.ms, 140, i)}`, c.x + 4 + Math.round(Math.cos(k) * 11), c.top - 6 + Math.round(Math.sin(k * 2) * 3));
      }
    },
  },
  fire_aura: {
    back(c) {
      const { ctx } = c, pulse = 0.25 + 0.08 * Math.sin(c.ms / 120);
      const g = ctx.createRadialGradient(c.x + 8, c.baseY - 9, 2, c.x + 8, c.baseY - 9, 16);
      g.addColorStop(0, `rgba(255,170,60,${pulse})`); g.addColorStop(1, 'rgba(255,80,30,0)');
      ctx.fillStyle = g; ctx.fillRect(c.x - 10, c.baseY - 28, 36, 32);
      rising(c, i => `flame_${1 + (i + Math.floor(c.ms / 90)) % 3}`, 4, 900, 7, 14);
    },
    front(c) { rising(c, i => `flame_${1 + (i + Math.floor(c.ms / 110)) % 3}`, 3, 1100, 8, 20); },
  },
  gum: { // somebody lost their trousers: legs where the pants were, and a bubblegum bubble
    look: l => ({ ...l, pants: l.skin, bottom: 2 }),
    front(c) {
      if (c.p.dir === 'up') return;
      const k = (c.ms % 2400) / 2400, r = k < 0.85 ? 1 + k * 4 : 0;
      if (!r) return;
      const bx = c.x + (c.p.dir === 'left' ? 3 : c.p.dir === 'right' ? 13 : 8), by = c.top + 12;
      c.ctx.fillStyle = '#f08ab8'; c.ctx.beginPath(); c.ctx.arc(bx, by, r, 0, Math.PI * 2); c.ctx.fill();
      c.ctx.fillStyle = '#ffd0e4'; c.ctx.fillRect(Math.round(bx - r / 2), Math.round(by - r / 2), 1, 1);
    },
  },
  drunk: {
    sway: (ms, seed, p) => {
      const s = Math.sin((ms + seed * 53) / (p.walking ? 160 : 420));
      return { dx: Math.round(s * (p.walking ? 2 : 1)), rot: s * (p.walking ? 0.16 : 0.1) };
    },
    front(c) { rising(c, () => 'sparkle_2', 2, 1600, 5, 8); }, // seeing stars
  },
  unicorns: { // three little rainbow unicorns trotting in a ring around them
    back(c) { unicorns(c, true); },
    front(c) { unicorns(c, false); },
  },
};
/** The Odyssey hats change the whole character: clothes, a layer behind them, a layer in front, and a hover (winged, in sway above). */
const ODYSSEY: Record<string, { look: Partial<Look>; back?(c: FxCtx): void; beforeHat?(c: FxCtx): void; front?(c: FxCtx): void }> = {
  laurel: { // Apollo: a white toga and gold sandals, a pulsing golden glow, laurel leaves drifting down
    look: { shirt: '#f4eddc', pants: '#e8d8b0', shoes: '#c8a030' },
    back(c) {
      const { ctx } = c, pulse = 0.3 + 0.1 * Math.sin(c.ms / 260);
      const g = ctx.createRadialGradient(c.x + 8, c.top + 8, 2, c.x + 8, c.top + 8, 17);
      g.addColorStop(0, `rgba(255,228,120,${pulse})`); g.addColorStop(1, 'rgba(255,200,60,0)');
      ctx.fillStyle = g; ctx.fillRect(c.x - 10, c.top - 10, 36, 38);
    },
    front(c) { falling(c, () => 'leaf', 5, 2600, 9, 22); },
  },
  winged: { // Hermes: a light-blue chiton, big flapping wings on the back (in front when facing away) and winged sandals, feathers falling
    look: { shirt: '#d8ecf8', pants: '#9ac0e0', shoes: '#f4f4f8' },
    back(c) { if (c.p.dir !== 'up') wings(c); },
    beforeHat(c) { // winged sandals, and the wings over the back when facing away
      c.blit('wing_foot_l', c.x - 1, c.baseY - 5); c.blit('wing_foot_r', c.x + 11, c.baseY - 5);
      if (c.p.dir === 'up') wings(c);
      falling(c, () => 'feather', 3, 3000, 9, 20);
    },
  },
  crested: { // the warrior: bronze armour and a crimson cloak that flutters when walking, dust at the heels, a gleam on the helmet
    look: { shirt: '#b8843c', pants: '#7a2a2a', shoes: '#5a3a20' },
    back(c) { if (c.p.dir !== 'up') cloak(c); },
    beforeHat(c) {
      if (c.p.dir === 'up') cloak(c);
      if (c.p.walking) for (let i = 0; i < 3; i++) { // dust kicked up behind each step
        const k = ((c.ms + i * 130) % 400) / 400, [dx, dy] = ({ left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] } as Record<string, number[]>)[c.p.dir] ?? [0, 0];
        c.ctx.fillStyle = `rgba(190,170,140,${0.6 * (1 - k)})`; c.ctx.fillRect(c.x + 7 + dx * (3 + k * 6) - i, c.baseY - 2 - k * 3 + dy * k * 4, 2, 2);
      }
    },
    front(c) { if (c.ms % 2600 < 260) c.blit(`sparkle_${flip(c.ms, 130)}`, c.x + 3, c.top - 6); },
  },
};
function wings(c: FxCtx) { // flapping fast while walking, slowly when still
  const n = c.p.walking ? flip(c.ms, 110) : flip(c.ms, 520), up = c.p.dir === 'up';
  c.blit(`wing_l_${n}`, c.x - 4, c.top + 5 + (up ? 1 : 0)); c.blit(`wing_r_${n}`, c.x + 11, c.top + 5 + (up ? 1 : 0));
}
function cloak(c: FxCtx) {
  const dx = c.p.dir === 'left' ? 2 : c.p.dir === 'right' ? -2 : 0, flutter = c.p.walking ? Math.round(Math.sin(c.ms / 90)) : 0;
  c.blit('cloak', c.x + 1 + dx + flutter, c.top + 10);
}
/** Particles drifting down from the head and swaying, each looping every `period` ms. */
function falling(c: FxCtx, frame: (i: number) => string, n: number, period: number, spread: number, height: number) {
  const { ctx } = c;
  for (let i = 0; i < n; i++) {
    const k = ((c.ms + c.seed * 131 + i * period / n) % period) / period;
    ctx.globalAlpha = Math.min(1, (1 - k) * 2, k * 6);
    c.blit(frame(i), c.x + 8 + Math.round(Math.sin(i * 2.4 + k * 6) * spread) - 1, c.top - 2 + Math.round(k * height));
  }
  ctx.globalAlpha = 1;
}
const HAT_H: Record<string, number> = { top: 11, party: 12, wizard: 14, cowboy: 8, crown: 8, judge: 13, laurel: 7, winged: 10, crested: 10 };

function unicorns(c: FxCtx, behind: boolean) {
  for (let i = 0; i < 3; i++) {
    const a = (c.ms / 2600 + i / 3) % 1 * Math.PI * 2, sin = Math.sin(a);
    if ((sin < 0) !== behind) continue; // the far half of the ring goes behind the person
    const ux = c.x + 8 + Math.round(Math.cos(a) * 16) - 6, uy = c.baseY - 9 + Math.round(sin * 6);
    const dir = -Math.sin(a) >= 0 ? 'r' : 'l'; // moving along the ring: x' = −sin
    const trail = ['#e8607a', '#f2d060', '#5a8ae8'];
    trail.forEach((col, j) => {
      const ta = a - (j + 1) * 0.12;
      c.ctx.fillStyle = col;
      c.ctx.fillRect(c.x + 8 + Math.round(Math.cos(ta) * 16) - 1, c.baseY - 4 + Math.round(Math.sin(ta) * 6), 2, 1);
    });
    c.blit(`unicorn_${dir}_${flip(c.ms, 150, i)}`, ux, uy);
  }
}

/** The look after every effect's palette tweak, in list order. */
export function effectLook(look: Look, effects: readonly Effect[] | undefined): Look {
  let l = look;
  for (const e of effects ?? []) { const d = EFFECT_DRAW[e.kind]?.look; if (d) l = d(l, e); }
  return l;
}
export function effectSway(effects: readonly Effect[] | undefined, ms: number, seed: number, p: Pose) {
  let dx = 0, rot = 0, dy = 0;
  for (const e of effects ?? []) { const s = EFFECT_DRAW[e.kind]?.sway?.(ms, seed, p, e); if (s) { dx += s.dx; rot += s.rot; dy += s.dy ?? 0; } }
  return { dx, rot, dy };
}
export function drawEffects(layer: 'back' | 'front', base: Omit<FxCtx, 'e'>, effects: readonly Effect[] | undefined) {
  for (const e of effects ?? []) EFFECT_DRAW[e.kind]?.[layer]?.({ ...base, e });
}
