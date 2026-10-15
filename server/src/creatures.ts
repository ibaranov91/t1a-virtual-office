// Office animals and helpers: a cat and a dog that wander, sit by people and nap; a bat in October; and the cleaner,
// who takes away the cups people leave on tables. They are not users: their own `creatures` message, never knocked on,
// never counted. Cups are server state, saved with the rest.
import { dirBetween, findPath, isWalkable, type Tile, type TileMap } from '../../shared/map';
import { isPlate, LUNCH_MS, MAX_PLATES } from '../../shared/lunch';
import { cupTableAt, MAX_CUPS, type Creature, type CreatureKind, type CreaturePose, type Cup, type ServerMsg } from '../../shared/protocol';

export const CUP_LINGER_MS = 12_000;       // the cleaner leaves a fresh cup alone for a bit
export const CUP_TTL_MS = 30 * 60_000;     // with no cleaner around (PETS=0), cups vanish on their own
export const CLEAN_MS = 1800;              // pausing at the table
export const PET_MS = 2000;                // the hearts
export const PET_FOLLOW_MS = 60_000;       // then it tags along with the person
export const BAT_CHANCE = 1 / 3;           // per try
export const BAT_COOLDOWN_MS = 1000;
export const BAT_RESPAWN_MS = 10 * 60_000; // after a catch
const SPEED: Record<CreatureKind, number> = { cat: 320, dog: 230, bat: 150, cleaner: 300 };

export interface CreatureHost {
  map(): TileMap;
  broadcast(msg: ServerMsg): void;
  people(): Tile[]; // where people (and bots) stand in the office right now
  personTile?(userId: string): Tile | null; // where this person is headed in the office, if they're about
}
interface Live extends Creature {
  until: number;                                   // busy (walking, sitting, napping…) until then
  then?: { pose: CreaturePose; ms: number }; // what to do on arrival
  cleaning?: string;                          // the cleaner: the cup she's on her way to (or wiping up)
  follow?: { userId: string; until: number }; // a petted cat or dog trots after its person for a while
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const N4: Tile[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
const inOctober = (d: Date) => d.getMonth() === 9;

/** A straight-ish flight: across, then up or down. Bats don't care about walls or chairs. */
export function flightPath(from: Tile, to: Tile): Tile[] {
  const out = [{ ...from }];
  let { x, y } = from;
  while (x !== to.x) { x += Math.sign(to.x - x); out.push({ x, y }); }
  while (y !== to.y) { y += Math.sign(to.y - y); out.push({ x, y }); }
  return out;
}

export class Creatures {
  list = new Map<string, Live>();
  cups: Cup[] = [];
  private seq = 0;
  batAlways = false;     // dev (BAT=1): the bat isn't just for October
  batBackAt = 0;         // after a catch, the bat stays away until then
  rng = Math.random;
  constructor(private host: CreatureHost) {}

  get map() { return this.host.map(); }
  toPublic = (c: Live): Creature => ({ id: c.id, kind: c.kind, name: c.name, tile: c.tile, dir: c.dir, pose: c.pose, walk: c.walk });
  all() { return [...this.list.values()].map(this.toPublic); }
  private announceAll() { this.host.broadcast({ t: 'creatures', creatures: this.all() }); }
  private announce(c: Live) { this.host.broadcast({ t: 'creature', creature: this.toPublic(c) }); }
  private announceCups() { this.host.broadcast({ t: 'cups', cups: this.cups }); }

  add(kind: CreatureKind, name: string, tile: Tile) {
    const c: Live = { id: `${kind}`, kind, name, tile: { ...tile }, dir: 'down', pose: kind === 'bat' ? 'hang' : 'idle', walk: null, until: 0 };
    this.list.set(c.id, c); this.announceAll();
    return c;
  }
  remove(id: string) { if (this.list.delete(id)) this.announceAll(); }

  /** Walk (or fly) somewhere; on arrival take up `then`. False if there's no way there. */
  go(c: Live, to: Tile, now: number, then?: Live['then'], path = c.kind === 'bat' ? flightPath(c.tile, to) : findPath(this.map, c.tile, to)) {
    if (!path.length) return false;
    const ms = SPEED[c.kind];
    c.walk = path.length > 1 ? { path, startedAt: now, ms } : null;
    c.tile = { ...to }; c.pose = 'idle'; c.then = then;
    if (path.length > 1) c.dir = dirBetween(path[path.length - 2], path[path.length - 1], c.dir);
    c.until = now + (path.length - 1) * ms;
    this.announce(c);
    return true;
  }
  private settle(c: Live, pose: CreaturePose, ms: number, now: number) {
    const changed = c.walk || c.pose !== pose;
    c.walk = null; c.pose = pose; c.until = now + ms; c.then = undefined;
    if (changed) this.announce(c);
  }

  // ---------- cups ----------
  /** The table (or desk, or counter) under this tile, if a cup can go on it. */
  tableAt(t: Tile) { return cupTableAt(this.map.objects, t); }
  cupProblem(t: Tile, item = ''): string | null {
    const plate = isPlate(item);
    if (!this.tableAt(t)) return plate ? 'Plates go on a table' : 'Cups go on a table';
    if (this.cups.some(c => c.tile.x === t.x && t.y === c.tile.y)) return 'There\'s a cup there already';
    if (this.cups.filter(c => isPlate(c.item) === plate).length >= (plate ? MAX_PLATES : MAX_CUPS)) return plate ? 'The tables are full of plates: wait for the cleaner' : 'The tables are full of cups: wait for the cleaner';
    return null;
  }
  /** Walkable tiles touching this tile, from where you can reach across to it. */
  beside(t: Tile) { return N4.map(d => ({ x: t.x + d.x, y: t.y + d.y })).filter(p => isWalkable(this.map, p.x, p.y)); }
  addCup(t: Tile, item: string, now: number): Cup | string {
    const problem = this.cupProblem(t, item);
    if (problem) return problem;
    const cup = { id: `cup${now.toString(36)}${(this.seq++).toString(36)}`, tile: { x: t.x, y: t.y }, item, at: now };
    this.cups = [...this.cups, cup]; this.announceCups();
    return cup;
  }
  removeCup(id: string) {
    const before = this.cups.length;
    this.cups = this.cups.filter(c => c.id !== id);
    if (this.cups.length !== before) this.announceCups();
  }

  // ---------- behaviour ----------
  tick(now: number, date = new Date(now)) {
    for (const cup of this.cups) if (now - cup.at > CUP_TTL_MS) this.removeCup(cup.id);
    const bat = this.list.get('bat');
    if (bat && !this.batSeason(date)) this.remove('bat');
    for (const c of this.list.values()) {
      if (now < c.until) continue;
      if (c.then) { // just arrived
        const gone = c.cleaning && !this.cups.some(k => k.id === c.cleaning);
        if (!gone) { this.settle(c, c.then.pose, c.then.ms, now); continue; }
        c.then = undefined; c.walk = null; c.cleaning = undefined; // someone beat her to it
      }
      if (c.kind === 'cleaner') this.cleaner(c, now);
      else if (c.kind === 'bat') this.flutter(c, now);
      else if (c.follow && this.followPerson(c, now)) continue;
      else this.wander(c, now);
    }
  }
  batSeason(d: Date) { return this.batAlways || inOctober(d); }

  // ---------- petting and catching ----------
  /** A pat for the cat or dog: hearts for a moment, then it follows that person about for a minute. */
  petBy(c: Live, userId: string, now: number) {
    this.settle(c, 'pet', PET_MS, now);
    c.follow = { userId, until: now + PET_FOLLOW_MS };
  }
  /** A try at the hanging bat. 'missed': it darts off to another room. 'caught': it's gone for a while. null: not catchable now. */
  tryBat(now: number): 'caught' | 'missed' | null {
    const bat = this.list.get('bat');
    if (!bat || bat.pose !== 'hang' || bat.walk) return null;
    if (this.rng() < BAT_CHANCE) { this.remove('bat'); this.batBackAt = now + BAT_RESPAWN_MS; return 'caught'; }
    this.flutter(bat, now);
    return 'missed';
  }
  /** Bring the bat back (not before a catch's break is over). */
  wantBat(now: number, date = new Date(now)) {
    if (this.list.has('bat') || now < this.batBackAt || !this.batSeason(date)) return;
    this.add('bat', 'Bat', { x: 20, y: 13 });
  }
  /** Trot after the petted person; true while it's still on that. */
  private followPerson(c: Live, now: number) {
    const f = c.follow!, at = now < f.until ? this.host.personTile?.(f.userId) : null;
    if (!at) { c.follow = undefined; return false; }
    if (Math.max(Math.abs(c.tile.x - at.x), Math.abs(c.tile.y - at.y)) <= 1) { this.settle(c, 'sit', 1500, now); return true; }
    const taken = new Set(this.host.people().map(p => `${p.x},${p.y}`));
    const spots = this.beside(at).filter(p => !taken.has(`${p.x},${p.y}`));
    if (spots.length && this.go(c, pick(spots), now, { pose: 'sit', ms: 1500 })) return true;
    c.follow = undefined; return false;
  }

  /** Cat and dog: trot over to someone and sit by them, potter about a room, or curl up for a nap. */
  private wander(c: Live, now: number) {
    const people = this.host.people(), r = Math.random(), dog = c.kind === 'dog';
    if (people.length && r < (dog ? 0.55 : 0.35)) {
      const near = pick(people), taken = new Set(people.map(p => `${p.x},${p.y}`));
      const spots = this.beside(near).filter(p => !taken.has(`${p.x},${p.y}`));
      if (spots.length && this.go(c, pick(spots), now, { pose: 'sit', ms: rand(12_000, 35_000) })) return;
    }
    if (r < (dog ? 0.85 : 0.65)) {
      const room = pick(this.map.rooms.filter(r => r.id !== 'meeting'));
      for (let i = 0; i < 12; i++) {
        const x = room.rect.x + Math.floor(Math.random() * room.rect.w), y = room.rect.y + Math.floor(Math.random() * room.rect.h);
        if (isWalkable(this.map, x, y) && this.go(c, { x, y }, now, { pose: 'idle', ms: rand(2000, 8000) })) return;
      }
    }
    this.settle(c, 'nap', dog ? rand(20_000, 50_000) : rand(30_000, 90_000), now);
  }

  /** The bat: dart along the top row of a room, hang there a while. */
  flutter(c: Live, now: number) {
    const room = pick(this.map.rooms.filter(r => r.id !== 'garden'));
    const to = { x: room.rect.x + Math.floor(Math.random() * room.rect.w), y: room.rect.y };
    this.go(c, to, now, { pose: 'hang', ms: rand(4000, 14_000) });
  }

  base(): Tile {
    const lobby = this.map.rooms.find(r => r.id === 'lobby');
    const spot = lobby?.stand.find(s => isWalkable(this.map, s.x, s.y));
    return spot ? { x: spot.x, y: spot.y } : { ...this.map.spawn };
  }
  /** The cleaner: the nearest settled cup, a pause at the table, then the next; home when the tables are clear. */
  private cleaner(c: Live, now: number) {
    if (c.pose === 'clean') { // finished wiping: take the cup away
      if (c.cleaning) this.removeCup(c.cleaning);
      c.cleaning = undefined;
      this.settle(c, 'idle', 0, now);
    }
    const plan = this.planClean(c.tile, now);
    if (plan) {
      c.cleaning = plan.cup.id;
      this.go(c, plan.spot, now, { pose: 'clean', ms: CLEAN_MS }, plan.path);
      return;
    }
    const home = this.base();
    if (c.tile.x !== home.x || c.tile.y !== home.y) this.go(c, home, now, { pose: 'idle', ms: 0 });
    else c.until = now + 1000;
  }
  /** Which cup next and where to stand for it: the nearest by path. */
  planClean(from: Tile, now: number) {
    let best: { cup: Cup; spot: Tile; path: Tile[] } | null = null;
    for (const cup of this.cups) {
      if (now - cup.at < CUP_LINGER_MS + (isPlate(cup.item) ? LUNCH_MS : 0)) continue; // a plate stays while its owner eats
      for (const spot of this.beside(cup.tile)) {
        const path = findPath(this.map, from, spot);
        if (path.length && (!best || path.length < best.path.length)) best = { cup, spot, path };
      }
    }
    return best;
  }
}

/** Spawn the animals and the cleaner (PETS, on unless PETS=0) and keep everything moving. Cups expire either way. */
export function startCreatures(c: Creatures, pets: boolean, batAlways = false) {
  c.batAlways = batAlways;
  if (pets) {
    const m = c.map, rooms = (id: string) => m.rooms.find(r => r.id === id);
    const spotIn = (id: string) => rooms(id)?.stand.find(s => isWalkable(m, s.x, s.y)) ?? m.spawn;
    c.add('cat', 'Biscuit', spotIn('lobby'));
    c.add('dog', 'Pixel', spotIn('cowork'));
    c.add('cleaner', 'Valentina', c.base());
  }
  setInterval(() => {
    const now = Date.now();
    if (pets) c.wantBat(now);
    c.tick(now);
  }, 500).unref();
}
