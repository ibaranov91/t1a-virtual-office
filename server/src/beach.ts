import { inWing, onMap, terrainAt } from '../../shared/beach';
import { besideObject, isWalkable, pathDuration, seatAt, type Dir, type Tile } from '../../shared/map';
import type { User, World } from './world';

type Activity = 'lounger' | 'bar' | 'swim' | 'mountain' | 'fishing' | 'hammock';
interface Plan { timer?: NodeJS.Timeout; reserved?: string; entry?: () => void }
const key = (t: Tile) => `${t.x},${t.y}`;
const same = (a: Tile, b: Tile) => a.x === b.x && a.y === b.y;
const distance = (a: Tile, b: Tile) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const seconds = (min: number, max: number) => (min + Math.random() * (max - min)) * 1000;

/** Offline avatars use ordinary World walks; only the activity plans live here. */
export class Beach {
  private plans = new Map<string, Plan>();
  private reserved = new Map<string, string>();
  private rounds = new Map<string, { round: number; order: Activity[] }>();
  constructor(private world: World) {}
  private eligible(u: User, entry = false) {
    return u.presence === 'offline' && !!u.vacation && !u.instance && (u.door === null || entry && u.door === 'arriving') && !u.following && ![...this.world.users.values()].some(f => f.following === u.id);
  }
  release(u: User) {
    const p = this.plans.get(u.id);
    clearTimeout(p?.timer);
    if (p?.reserved && this.reserved.get(p.reserved) === u.id) this.reserved.delete(p.reserved);
    this.plans.delete(u.id);
  }
  cancelAll() {
    const arrivals: { u: User; entry: () => void }[] = [];
    for (const id of this.plans.keys()) {
      const u = this.world.users.get(id);
      if (u) { const entry = this.plans.get(id)?.entry; if (entry) arrivals.push({ u, entry }); this.release(u); if (u.move) this.world.walk(u, this.world.position(u).next); }
    }
    return arrivals;
  }
  tick() {
    if (!this.world.map.vacation) return;
    for (const u of this.world.users.values()) {
      if (!this.eligible(u)) { if (u.door !== 'arriving') this.release(u); continue; }
      if (!this.plans.has(u.id) && (!u.move || !u.path || Date.now() >= u.move.startedAt + pathDuration(u.path, u.move.ms))) this.start(u);
    }
  }
  private free(u: User, t: Tile) {
    if (this.reserved.has(key(t)) && this.reserved.get(key(t)) !== u.id) return false;
    return ![...this.world.users.values()].some(o => o !== u && o.instance === null && onMap(o) && same(o.tile, t));
  }
  private sand(u: User) {
    const m = this.world.map, out: Tile[] = [];
    for (const r of m.rooms.filter(r => r.id === 'beach' || r.id === 'mountains'))
      for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++)
        if (terrainAt(m, x, y) === 'sand' && isWalkable(m, x, y) && this.free(u, { x, y })) out.push({ x, y });
    return out;
  }
  boot(u: User) {
    this.release(u);
    const spots = this.world.map.rooms.filter(r => r.id === 'beach' || r.id === 'mountains').flatMap(r => r.spots).filter(t => this.free(u, t));
    const t = pick(spots.length ? spots : this.sand(u)) ?? this.world.map.vacation?.gate;
    if (t) { u.tile = { x: t.x, y: t.y }; u.move = null; u.path = null; u.prev = undefined; }
  }
  arrive(u: User, arrived: () => void) { this.start(u, arrived); }
  private next(u: User): Activity {
    let r = this.rounds.get(u.id);
    if (!r) this.rounds.set(u.id, r = { round: 0, order: [] });
    if (!r.order.length) {
      r.order = ['lounger', 'bar', 'swim', 'mountain', 'fishing', 'hammock'];
      let seed = 2166136261;
      for (const c of `${u.id}:${r.round++}`) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
      for (let i = r.order.length - 1; i > 0; i--) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const j = (seed >>> 0) % (i + 1); [r.order[i], r.order[j]] = [r.order[j], r.order[i]]; }
    }
    return r.order.shift()!;
  }
  private wait(u: User, p: Plan, ms: number, run: () => void) {
    const seq = u.walkSeq;
    p.timer = setTimeout(() => {
      if (this.plans.get(u.id) !== p) return;
      if (u.walkSeq !== seq || !this.eligible(u, !!p.entry)) { this.release(u); return; }
      run();
    }, Math.max(0, ms));
  }
  private done(u: User, p: Plan) {
    p.entry?.(); p.entry = undefined;
    this.release(u);
  }
  private go(u: User, p: Plan, to: Tile, run: () => void, face?: Dir, speed?: number) {
    if (!this.free(u, to)) { this.done(u, p); return; }
    let at = this.world.walk(u, to, face, undefined, speed);
    if (at === null) {
      if (!p.entry) { this.done(u, p); return; }
      // A broken route must not strand an arriving person at the gate forever.
      u.tile = { ...to }; u.move = null; u.path = null; u.prev = undefined;
      at = this.world.walk(u, to, face) ?? Date.now();
    }
    this.wait(u, p, at - Date.now(), () => {
      p.entry?.(); p.entry = undefined;
      if ([...this.world.users.values()].some(o => o !== u && o.presence !== 'offline' && !o.instance && same(this.world.position(o).tile, to))) { this.done(u, p); return; }
      run();
    });
  }
  private reserve(u: User, p: Plan, t: Tile) { p.reserved = key(t); this.reserved.set(p.reserved, u.id); }
  private start(u: User, entry?: () => void) {
    this.release(u);
    const v = this.world.map.vacation;
    if (!v || !this.eligible(u, !!entry)) { entry?.(); return; }
    const p: Plan = { entry }; this.plans.set(u.id, p);
    const finish = () => this.done(u, p);
    const idle = (min: number, max: number) => this.wait(u, p, seconds(min, max), finish);
    const furniture = this.world.map.objects.filter(o => inWing(this.world.map, o.x, o.y) && inWing(this.world.map, o.x + o.w - 1, o.y + o.h - 1));
    for (let tries = 0; tries < 6; tries++) {
      const activity = this.next(u);
      if (activity === 'lounger' || activity === 'hammock') {
        const seats = furniture.filter(o => o.type === activity && o.lie).flatMap(o => {
          const s = seatAt(this.world.map, o.x + Math.floor((o.w - 1) / 2), o.y); return s && this.free(u, s) ? [s] : [];
        });
        if (!seats.length) continue;
        const s = pick(seats); this.reserve(u, p, s);
        this.go(u, p, s, () => idle(activity === 'lounger' ? 60 : 45, activity === 'lounger' ? 120 : 90), s.dir); return;
      }
      if (activity === 'fishing') {
        const spots = v.pierEnds.filter(t => this.free(u, t)); if (!spots.length) continue;
        const s = pick(spots); this.reserve(u, p, s); this.go(u, p, s, () => idle(45, 90), 'down'); return;
      }
      if (activity === 'bar') {
        const bar = furniture.find(o => o.type === 'beach_bar' && o.use?.kind === 'take');
        if (!bar || bar.use?.kind !== 'take' || !bar.use.items.length) continue;
        const items = bar.use.items, spots = besideObject(this.world.map, bar).filter(s => s.y === bar.y + bar.h && this.free(u, s));
        if (!spots.length) continue;
        this.go(u, p, pick(spots), () => this.wait(u, p, 3000, () => { this.world.setHolding(u, pick(items).id, bar.id); finish(); this.start(u); }), 'up'); return;
      }
      if (activity === 'mountain') {
        if (!this.free(u, v.summit) || !this.free(u, v.trailFoot)) continue;
        this.reserve(u, p, v.summit);
        this.go(u, p, v.trailFoot, () => this.go(u, p, v.summit, () => this.wait(u, p, seconds(15, 25), () => this.go(u, p, v.trailFoot, finish, undefined, 400)), undefined, 400)); return;
      }
      if (activity === 'swim') {
        const spots = v.swim.filter(s => this.free(u, s)).sort((a, b) => distance(u.tile, a) - distance(u.tile, b));
        if (!spots.length) continue;
        let legs = 2 + Math.floor(Math.random() * 2);
        const shore = () => { const s = this.sand(u).sort((a, b) => distance(u.tile, a) - distance(u.tile, b))[0]; if (s) this.go(u, p, s, finish); else finish(); };
        const leg = () => this.wait(u, p, seconds(8, 15), () => {
          if (!legs--) { shore(); return; }
          const next = v.swim.filter(s => !same(s, u.tile) && distance(s, u.tile) <= 12 && this.free(u, s));
          if (!next.length) { shore(); return; }
          this.go(u, p, pick(next), leg);
        });
        this.go(u, p, spots[0], leg); return;
      }
    }
    const s = pick(this.sand(u));
    if (s) this.go(u, p, s, () => idle(20, 40)); else { entry?.(); p.entry = undefined; this.wait(u, p, 1000, finish); }
  }
}
