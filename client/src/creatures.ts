// The office animals, the cleaner, the cups on tables, and the ghost of Mazurkevich. The engine merges these into its
// y-sorted pass; this file only knows how to place and draw them.
import { sampleMove, WALK_MS_PER_TILE, type Dir, type Rect } from '../../shared/map';
import { cupTableAt, type Creature } from '../../shared/protocol';
import type { Frame } from './assets';
import { MAP, type Store } from './net';

const TS = MAP.tileSize;
const KIND_NAME: Record<Creature['kind'], string> = { cat: 'the office cat', dog: 'the office dog', bat: 'an October bat 🦇', cleaner: 'cleaning up' };
const POSE_NAME: Record<Creature['pose'], string> = { idle: '', sit: 'keeping someone company', nap: 'napping', clean: 'wiping a table', hang: 'hanging about' };

export interface Placed { base: number; draw: () => void }
interface CreaturePose { x: number; y: number; dir: Dir; walking: boolean }

/** Where a creature is now: its walk, at its own pace. */
export function creaturePose(c: Creature, t: number): CreaturePose {
  if (c.walk) {
    const scaled = c.walk.startedAt + (t - c.walk.startedAt) * (WALK_MS_PER_TILE / c.walk.ms);
    const s = sampleMove(c.walk.path, c.walk.startedAt, scaled);
    if (s && !s.done) return { x: s.x, y: s.y, dir: s.dir, walking: true };
  }
  return { x: c.tile.x, y: c.tile.y, dir: c.dir, walking: false };
}

// ---------- the ghost ----------
/** Night as the floor's tint has it (deep blue): the ghost is about for a few minutes of every ten. By day he shows up
 *  for three minutes somewhere in each hour. Everyone sees the same windows (server time), each in their own night. */
const seed = (n: number) => { let h = n | 0; h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); return (h ^ (h >>> 16)) >>> 0; };
const night = (d: Date) => { const h = d.getHours() + d.getMinutes() / 60; return h >= 21 || h < 5.5; };
export function ghostWindow(now: number, forced: { from: number; to: number } | null, local = new Date()) {
  if (forced && now >= forced.from && now < forced.to) return forced;
  const span = night(local) ? 600_000 : 3_600_000, block = Math.floor(now / span);
  const from = block * span + (seed(block) % (night(local) ? 6 : 57)) * 60_000, to = from + (night(local) ? 4 : 3) * 60_000;
  return now >= from && now < to ? { from, to } : null;
}
const ROOMS = ['lobby', 'coffee'].map(id => MAP.rooms.find(r => r.id === id)!.rect);
/** Where he drifts: between spots in the Lobby and the Coffee room, straight through walls, a tile every second or so. */
export function ghostAt(win: { from: number; to: number }, now: number) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const r: Rect = ROOMS[(i + seed(win.from)) % 2], s = seed(win.from + i * 7919);
    pts.push({ x: r.x + 1 + (s % Math.max(1, r.w - 2)), y: r.y + 2 + ((s >>> 8) % Math.max(1, r.h - 3)) });
  }
  let left = (now - win.from) / 1100, i = 0;
  for (;;) {
    const a = pts[i % pts.length], b = pts[(i + 1) % pts.length], d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    if (left <= d) {
      const f = left / d, fade = Math.min(1, (now - win.from) / 2500, (win.to - now) / 2500);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, left: b.x < a.x, alpha: Math.max(0, fade) };
    }
    left -= d; i++;
  }
}

export class CreatureLayer {
  private facing = new Map<string, boolean>(); // left? kept while walking up or down
  forcedGhost: { from: number; to: number } | null = null;
  constructor(private store: Store, private ctx: () => CanvasRenderingContext2D, private f: (name: string) => Frame | undefined,
    private blit: (name: string, x: number, y: number) => void) {}

  /** Dev: bring the ghost out now, for a minute. */
  summonGhost(ms = 60_000) { const now = this.store.now(); this.forcedGhost = { from: now, to: now + ms }; }

  private drawFrame(name: string, cx: number, bottom: number, left: boolean, alpha = 1) {
    const fr = this.f(name); if (!fr) return;
    const ctx = this.ctx(), x = Math.round(cx - fr.w / 2), y = Math.round(bottom - fr.h);
    ctx.globalAlpha = alpha;
    if (left) { ctx.save(); ctx.translate(x * 2 + fr.w, 0); ctx.scale(-1, 1); this.blit(name, x, y); ctx.restore(); }
    else this.blit(name, x, y);
    ctx.globalAlpha = 1;
  }
  private shadow(cx: number, bottom: number, rx: number) {
    const ctx = this.ctx();
    ctx.fillStyle = 'rgba(40,20,25,0.25)';
    ctx.beginPath(); ctx.ellipse(cx, bottom - 1.5, rx, 1.6, 0, 0, Math.PI * 2); ctx.fill();
  }
  private frameFor(c: Creature, p: CreaturePose, ms: number) {
    const step = Math.floor(ms / (c.kind === 'dog' ? 120 : 160)) % 2;
    if (c.kind === 'bat') return p.walking ? `bat_fly_${Math.floor(ms / 90) % 2}` : 'bat_hang';
    if (c.kind === 'cleaner') return c.pose === 'clean' && !p.walking ? `cleaner_clean_${Math.floor(ms / 260) % 2}` : p.walking ? `cleaner_${step}` : 'cleaner_0';
    return p.walking ? `${c.kind}_walk_${step}` : c.pose === 'nap' ? `${c.kind}_nap` : c.pose === 'sit' || c.pose === 'idle' && c.kind === 'cat' ? `${c.kind}_sit` : `${c.kind}_walk_0`;
  }
  private left(c: Creature, dir: Dir) {
    if (dir === 'left' || dir === 'right') this.facing.set(c.id, dir === 'left');
    return this.facing.get(c.id) ?? false;
  }

  /** Everything that stands on the floor, for the engine's y-sorted pass. */
  placed(t: number, ms: number): Placed[] {
    const out: Placed[] = [];
    for (const cup of this.store.cups) {
      const table = cupTableAt(MAP.objects, cup.tile);
      const base = table ? (table.y + table.h) * TS - 0.25 : (cup.tile.y + 1) * TS;
      const lift = table ? Math.max(0, (this.f(table.type)?.h ?? 0) - table.h * TS) : 0; // the table top sits above its tiles
      out.push({ base, draw: () => this.blit(`cup_${cup.item === 'tea' ? 'tea' : 'coffee'}`, cup.tile.x * TS + 5, cup.tile.y * TS + 6 - lift) });
    }
    for (const c of this.store.creatures.values()) {
      if (c.kind === 'bat') continue; // flies over everything: drawn on top
      const p = creaturePose(c, t), cx = p.x * TS + 8, bottom = p.y * TS + TS;
      out.push({ base: bottom, draw: () => {
        const left = this.left(c, p.dir);
        this.shadow(cx, bottom, c.kind === 'cleaner' ? 5 : 4.5);
        this.drawFrame(this.frameFor(c, p, ms), cx, bottom - (c.kind === 'cleaner' ? 1 : 0), left);
        if (c.pose === 'nap' && !p.walking) {
          const ctx = this.ctx(), ph = (ms / 1400) % 1;
          ctx.globalAlpha = 1 - ph; ctx.fillStyle = '#e8e4ff'; ctx.font = '6px system-ui, sans-serif';
          ctx.fillText('z', cx + 4 + ph * 3, bottom - 10 - ph * 8); ctx.globalAlpha = 1;
        }
      } });
    }
    const win = ghostWindow(t, this.forcedGhost);
    if (win) {
      const g = ghostAt(win, t), cx = g.x * TS + 8, bottom = g.y * TS + TS;
      out.push({ base: bottom, draw: () => this.drawFrame(`ghost_${Math.floor(ms / 400) % 2}`, cx, bottom - 3 + Math.sin(ms / 500) * 2, g.left, 0.55 * g.alpha) });
    }
    return out;
  }
  /** Above the furniture and the people: the bat, up by the ceiling. */
  drawAbove(t: number, ms: number) {
    const c = this.store.creatures.get('bat'); if (!c) return;
    const p = creaturePose(c, t);
    this.drawFrame(this.frameFor(c, p, ms), p.x * TS + 8, p.y * TS + (p.walking ? 4 + Math.sin(ms / 140) * 2 : 8), this.left(c, p.dir));
  }

  /** What's under the pointer, as a name tag and where to put it. */
  at(wx: number, wy: number, t: number): { text: string; x: number; y: number } | null {
    const win = ghostWindow(t, this.forcedGhost);
    if (win) {
      const g = ghostAt(win, t), cx = g.x * TS + 8, bottom = g.y * TS + TS;
      if (g.alpha > 0.3 && Math.abs(wx - cx) < 8 && wy > bottom - 24 && wy < bottom) return { text: 'Mazurkevich 👻', x: cx, y: bottom - 20 };
    }
    for (const c of this.store.creatures.values()) {
      const p = creaturePose(c, t), cx = p.x * TS + 8, bottom = c.kind === 'bat' ? p.y * TS + 8 : p.y * TS + TS;
      const h = c.kind === 'cleaner' ? 24 : c.kind === 'bat' ? 10 : 14;
      if (Math.abs(wx - cx) < 8 && wy > bottom - h && wy < bottom) {
        const doing = POSE_NAME[c.pose];
        return { text: `${c.name} · ${c.kind === 'cleaner' ? (c.pose === 'clean' ? 'tidying up the cups' : 'the cleaner') : KIND_NAME[c.kind]}${doing && c.kind !== 'cleaner' && !p.walking ? ` · ${doing}` : ''}`, x: cx, y: bottom - h + 4 };
      }
    }
    return null;
  }
}
