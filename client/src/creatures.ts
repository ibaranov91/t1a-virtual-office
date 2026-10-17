// The office animals, the cleaner, the cups on tables, and the ghost of Mazurkevich. The engine merges these into its
// y-sorted pass; this file only knows how to place and draw them.
import { terrainAt } from '../../shared/beach';
import { roomAt, sampleMove, WALK_MS_PER_TILE, type Dir, type Rect } from '../../shared/map';
import { isPlate, LUNCH_MS, plateFood } from '../../shared/lunch';
import { CUP_ITEMS, cupTableAt, type Creature, type Cup } from '../../shared/protocol';
import { DRINKS } from '../../shared/drinks';
import { canCarry, itemDef } from '../../shared/items';
import { phrase } from '../../shared/phrases';
import type { Frame } from './assets';
import { itemTop } from './tableTops';
import { MAP, type Store } from './net';

const TS = MAP.tileSize;
const KIND_NAME: Record<Creature['kind'], string> = { cat: 'the office cat', dog: 'the office dog', bat: 'an October bat 🦇', cleaner: 'cleaning up' };
const POSE_NAME: Record<Creature['pose'], string> = { idle: '', sit: 'keeping someone company', nap: 'napping', clean: 'wiping a table', hang: 'hanging about', pet: 'being petted', paw: 'testing the water', shake: 'shaking off' };

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
const BOUNCER = MAP.objects.find(o => o.type === 'bouncer'); // a map object, not a creature: his lines are client-only, like the ghost
const KEIKO = MAP.objects.find(o => o.type === 'keiko'); // the 7/11 cashier: also a map object. Greeting, idle and linger lines are client-only; checkout and talk lines come from the server (npc_say)
const SAY_MS = 5000;
const sayFor = (text: string) => SAY_MS + text.length * 45; // her lines are long: leave time to read them
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
  private keiko = { say: '', until: 0, next: 0, was: false, since: 0, heard: 0 }; // her current line, the idle clock, whether I was in the shop last frame, when I walked in, the last npc_say shown
  private bouncer = { say: '', until: 0, next: 0 }; // his idle line and its clock (each client rolls its own)
  constructor(private store: Store, private ctx: () => CanvasRenderingContext2D, private f: (name: string) => Frame | undefined,
    private blit: (name: string, x: number, y: number) => void) {}

  /** Dev: bring the ghost out now, for a minute. */
  summonGhost(ms = 60_000) { const now = this.store.now(); this.forcedGhost = { from: now, to: now + ms }; }

  /** Dev: the bat is out of season (server needs BAT=1, which `npm run dev` sets). */
  summonBat() { this.store.devBat(); }

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
  /** Where a dog paddles: a wavy waterline across it and a ring spreading out. */
  private ripple(cx: number, lineY: number, ms: number) {
    const ctx = this.ctx();
    ctx.save(); ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(220,250,248,0.7)'; ctx.beginPath();
    for (let i = -6; i <= 6; i += 2) { const y = lineY + Math.sin(i / 2 + ms / 400) * 0.6; if (i === -6) ctx.moveTo(cx + i, y); else ctx.lineTo(cx + i, y); }
    ctx.stroke();
    const ph = (ms / 1400) % 1;
    ctx.globalAlpha = 0.5 * (1 - ph); ctx.beginPath(); ctx.ellipse(cx, lineY + 1, 6 + ph * 4, 1.5 + ph * 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  /** Droplets flung off a shaking dog. */
  private spray(cx: number, bottom: number, ms: number) {
    const ctx = this.ctx();
    ctx.fillStyle = '#5aaed8';
    for (let i = 0; i < 6; i++) {
      const ph = (ms / 500 + i / 6) % 1, a = (i / 6) * Math.PI * 2 + 0.4;
      ctx.globalAlpha = 1 - ph * 0.7; ctx.fillRect(Math.round(cx + Math.cos(a) * (4 + ph * 7)), Math.round(bottom - 7 + Math.sin(a) * (3 + ph * 5) + ph * ph * 4), 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  /** A ♪ that bobs and sways over the head, drawn in code. */
  private note(cx: number, y: number, ms: number) {
    const ctx = this.ctx(), ph = (ms / 900) % 1;
    ctx.save(); ctx.globalAlpha = Math.min(1, 2 - ph * 2); ctx.font = 'bold 8px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#2a1a22'; ctx.fillText('♪', Math.round(cx + 5 + Math.sin(ms / 300) * 2) + 0.4, Math.round(y - ph * 5) + 0.4);
    ctx.fillStyle = '#ffd86a'; ctx.fillText('♪', Math.round(cx + 5 + Math.sin(ms / 300) * 2), Math.round(y - ph * 5));
    ctx.restore();
  }
  /** A small speech bubble with a tail, centred over the head. */
  private say(text: string, cx: number, y: number) {
    const ctx = this.ctx();
    ctx.save(); ctx.font = '5px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const matrix = ctx.getTransform(), left = -matrix.e / matrix.a, right = (ctx.canvas.width - matrix.e) / matrix.a;
    const maxWidth = Math.min(100, right - left - 10), lines: string[] = [];
    for (const word of text.split(' ')) {
      const last = lines.length - 1, next = last < 0 ? word : `${lines[last]} ${word}`;
      if (last < 0 || ctx.measureText(next).width > maxWidth) lines.push(word);
      else lines[last] = next;
    }
    const w = Math.ceil(Math.max(...lines.map(line => ctx.measureText(line).width))) + 6, h = lines.length * 7 + 2;
    const x = Math.round(Math.max(left + 2, Math.min(right - w - 2, cx - w / 2))), top = y - h - 2;
    ctx.fillStyle = '#fff8ec'; ctx.strokeStyle = '#2a1a22'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, top, w, h, 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 2, top + h); ctx.lineTo(cx, top + h + 3); ctx.lineTo(cx + 2, top + h); ctx.fillStyle = '#fff8ec'; ctx.fill();
    ctx.fillStyle = '#2a1a22'; ctx.textAlign = 'center';
    lines.forEach((line, i) => ctx.fillText(line, x + w / 2, top + 5 + i * 7));
    ctx.restore();
  }
  private frameFor(c: Creature, p: CreaturePose, ms: number) {
    const step = Math.floor(ms / (c.kind === 'dog' ? 120 : 160)) % 2;
    if (c.kind === 'bat') return p.walking ? `bat_fly_${Math.floor(ms / 90) % 2}` : 'bat_hang';
    if (c.kind === 'cleaner') return c.pose === 'clean' && !p.walking ? `cleaner_clean_${Math.floor(ms / 260) % 2}` : p.walking ? `cleaner_${step}` : 'cleaner_0';
    if (c.kind === 'cat' && c.pose === 'paw' && !p.walking) return `cat_paw_${Math.floor(ms / 380) % 2}`;
    return p.walking ? `${c.kind}_walk_${step}` : c.pose === 'nap' ? `${c.kind}_nap` : c.pose === 'sit' || c.pose === 'pet' || c.pose === 'idle' && c.kind === 'cat' ? `${c.kind}_sit` : `${c.kind}_walk_0`;
  }
  private left(c: Creature, dir: Dir) {
    if (dir === 'left' || dir === 'right') this.facing.set(c.id, dir === 'left');
    return this.facing.get(c.id) ?? false;
  }

  /** The sprite for a cup: on a table its own cup or glass, on the floor a cup on its side or a broken glass. */
  private cupFrame(cup: Cup) {
    if (cup.floor) return DRINKS[cup.item]?.glass ? 'floor_glass' : `floor_cup_${cup.item === 'tea' ? 'tea' : 'coffee'}`;
    return this.f(`cup_${cup.item}`) ? `cup_${cup.item}` : 'cup_coffee';
  }
  /** Top-left of a cup's (or plate's) sprite in world pixels: on its table's top, or for a floor cup centred on its
   *  tile with its bottom on the tile's bottom (under the feet of whoever stands there). */
  private cupSpot(cup: Cup) {
    if (cup.floor) {
      const fr = this.f(this.cupFrame(cup)), w = fr?.w ?? 10, h = fr?.h ?? 6;
      return { x: cup.tile.x * TS + Math.floor((TS - w) / 2), y: (cup.tile.y + 1) * TS - h - 1, w, h };
    }
    const table = cupTableAt(MAP.objects, cup.tile), fh = table && this.f(table.type)?.h;
    return { x: cup.tile.x * TS + (isPlate(cup.item) ? 4 : 5), y: table && fh ? itemTop(table, cup.tile.y, fh, TS) : cup.tile.y * TS + 6, w: 6, h: 6 };
  }
  /** The cup drawn under this world point (with a pixel or two of slack), to click it away. Plates aren't: someone
   *  may still be eating. */
  cupAt(wx: number, wy: number) {
    return this.store.cups.find(c => { const p = this.cupSpot(c); return (CUP_ITEMS.includes(c.item) || canCarry(c.item)) && wx >= p.x - 2 && wx < p.x + p.w + 2 && wy >= p.y - 3 && wy < p.y + p.h + 2; }) ?? null;
  }
  /** What hovering a cup says. */
  cupLabel(cup: Cup) {
    if (!CUP_ITEMS.includes(cup.item) && canCarry(cup.item)) { // a thrown or dropped item
      const def = itemDef(cup.item), who = cup.by && this.store.users.get(cup.by)?.name;
      return `${def?.icon ?? '📦'} ${def?.label ?? cup.item}${who ? ` · from ${who}` : ''} · click to pick up`;
    }
    const glass = !!DRINKS[cup.item]?.glass, icon = cup.item === 'tea' ? '🍵' : cup.item === 'beer' ? '🍺' : cup.item === 'wine' ? '🍷' : cup.item === 'cocktail' ? '🍸' : '☕';
    if (!cup.floor) return `${icon} Someone left this here · click to clear it away`;
    const who = cup.by && this.store.users.get(cup.by)?.name;
    return who ? `${icon} ${who}'s empty ${glass ? 'glass' : 'cup'} · click to tidy` : `${icon} an empty ${glass ? 'glass' : 'cup'} · click to tidy`;
  }

  /** Everything that stands on the floor, for the engine's y-sorted pass. */
  placed(t: number, ms: number): Placed[] {
    const out: Placed[] = [];
    if (BOUNCER) {
      const b = this.bouncer;
      b.next ||= t + 20_000 + Math.random() * 60_000;
      if (t >= b.next) { b.say = phrase('bouncer', 'idle'); b.until = t + SAY_MS; b.next = t + 60_000 + Math.random() * 120_000; }
      if (t < b.until) out.push({ base: (BOUNCER.y + BOUNCER.h) * TS + 0.5, draw: () => this.say(b.say, (BOUNCER.x + BOUNCER.w / 2) * TS, BOUNCER.y * TS - 6) });
    }
    if (KEIKO) {
      const k = this.keiko, me = this.store.users.get(this.store.me), inShop = !!me && !me.instance && roomAt(MAP, this.store.pose(me, this.store.now()).tile.x, this.store.pose(me, this.store.now()).tile.y)?.id === 'shop';
      const said = this.store.npcSays.get(KEIKO.id);
      if (said && said.at !== k.heard) { k.heard = said.at; k.say = said.text; k.until = t + sayFor(said.text); }
      if (inShop && !k.was) { k.say = phrase('keiko', 'greeting'); k.until = t + sayFor(k.say); k.since = t; k.next = t + 60_000 + Math.random() * 60_000; }
      else if (inShop && t >= k.next) { // quiet for a while: an idle line, or a nudge to buy something when you only linger
        k.say = phrase('keiko', t - k.since > 90_000 ? 'talk' : 'idle'); k.until = t + sayFor(k.say); k.next = t + 70_000 + Math.random() * 90_000;
      }
      k.was = inShop;
      if (inShop && t < k.until) out.push({ base: (KEIKO.y + KEIKO.h) * TS + 0.5, draw: () => this.say(k.say, (KEIKO.x + KEIKO.w / 2) * TS, KEIKO.y * TS - 10) });
    }
    for (const cup of this.store.cups) {
      const table = cupTableAt(MAP.objects, cup.tile);
      const base = cup.floor ? cup.tile.y * TS + 0.25 : table ? (table.y + table.h) * TS - 0.25 : (cup.tile.y + 1) * TS; // floor litter: under anyone on its tile
      const { x, y } = this.cupSpot(cup);
      if (isPlate(cup.item)) { // the food while lunch lasts, then the crumbs
        out.push({ base, draw: () => this.blit(this.store.now() < cup.at + LUNCH_MS ? `plate_${plateFood(cup.item)}` : 'plate_empty', x, y) });
        continue;
      }
      if (!CUP_ITEMS.includes(cup.item) && canCarry(cup.item)) { // a thrown or dropped item: its sprite if it has one, else its emoji on the floor
        const def = itemDef(cup.item), frame = def?.sprite && this.f(def.sprite) ? def.sprite : null;
        out.push({ base, draw: () => {
          if (frame) return this.blit(frame, x, y);
          const ctx = this.ctx();
          ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 1, y + 4, 8, 2);
          ctx.fillStyle = '#000'; ctx.font = '8px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(def?.icon ?? '📦', x + 5, y + 2); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        } });
        continue;
      }
      const name = this.cupFrame(cup);
      out.push({ base, draw: () => this.blit(name, x, y) });
    }
    for (const c of this.store.creatures.values()) {
      if (c.kind === 'bat') continue; // flies over everything: drawn on top
      const p = creaturePose(c, t), cx = p.x * TS + 8, bottom = p.y * TS + TS;
      const wet = c.kind === 'dog' && ['shallow', 'deep'].includes(terrainAt(MAP, Math.round(p.x), Math.round(p.y)) ?? '');
      out.push({ base: bottom, draw: () => {
        const left = this.left(c, p.dir), ctx = this.ctx();
        if (wet) { // paddling: legs and belly under the waterline, the head bobbing
          const line = bottom - 5;
          ctx.save(); ctx.beginPath(); ctx.rect(cx - 12, line - 24, 24, 24); ctx.clip();
          this.drawFrame(p.walking ? 'dog_walk_0' : 'dog_sit', cx, bottom + Math.round(Math.sin(ms / 300)), left);
          ctx.restore(); this.ripple(cx, line, ms);
        } else if (c.pose === 'shake' && !p.walking) {
          this.shadow(cx, bottom, 4.5);
          this.drawFrame('dog_walk_0', cx + (Math.floor(ms / 50) % 2 ? 1 : -1), bottom, left);
          this.spray(cx, bottom, ms);
        } else {
          this.shadow(cx, bottom, c.kind === 'cleaner' ? 5 : 4.5);
          this.drawFrame(this.frameFor(c, p, ms), cx, bottom - (c.kind === 'cleaner' ? 1 : 0), left);
        }
        if (c.hum) this.note(cx, bottom - 27, ms);
        if (c.say) this.say(c.say, cx, bottom - 31);
        if (c.pose === 'pet' && !p.walking) for (let i = 0; i < 3; i++) { // hearts drifting up
          const ph = (ms / 900 + i / 3) % 1, ctx = this.ctx();
          ctx.globalAlpha = Math.min(1, 2 - ph * 2); this.blit('heart', Math.round(cx - 3 + (i - 1) * 5 + Math.sin(ph * 6 + i) * 1.5), Math.round(bottom - 16 - ph * 10)); ctx.globalAlpha = 1;
        }
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
  at(wx: number, wy: number, t: number): { text: string; x: number; y: number; id?: string } | null {
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
        if (c.kind === 'bat' && c.pose === 'hang' && !p.walking) return { text: 'Bat · catch it!', x: cx, y: bottom - h + 4, id: c.id };
        if (c.kind === 'cat' || c.kind === 'dog') return { text: `${c.name} · the office ${c.kind} · click to pet`, x: cx, y: bottom - h + 4, id: c.id };
        return { text: `${c.name} · ${c.kind === 'cleaner' ? (c.pose === 'clean' ? 'tidying up the cups' : 'on her rounds') : KIND_NAME[c.kind]}${doing && c.kind !== 'cleaner' && !p.walking ? ` · ${doing}` : ''}`, x: cx, y: bottom - h + 4 };
      }
    }
    return null;
  }
}
