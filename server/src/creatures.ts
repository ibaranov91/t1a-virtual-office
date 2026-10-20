// Office animals and helpers: a cat and a dog that wander, sit by people and nap; a bat in October; and the cleaner,
// who takes away the cups people leave on tables. They are not users: their own `creatures` message, never knocked on,
// never counted. Cups are server state, saved with the rest.
import { terrainAt } from '../../shared/beach';
import { dirBetween, findPath, isWalkable, roomAt, type Dir, type Tile, type TileMap } from '../../shared/map';
import { isToy } from '../../shared/items';
import { SPAWN_BY } from '../../shared/spawns';
import { isPlate, LUNCH_MS, MAX_PLATES } from '../../shared/lunch';
import { phrase, type Speaker } from '../../shared/phrases';
import { cupTableAt, MAX_CUPS, type Creature, type CreatureKind, type CreaturePose, type Cup, type ServerMsg } from '../../shared/protocol';

export const CUP_LINGER_MS = 12_000;       // the cleaner leaves a fresh cup alone for a bit
export const CUP_TTL_MS = 30 * 60_000;     // with no cleaner around (PETS=0), cups vanish on their own
export const MAX_TOYS = 24;                // toys put down around the office (spawns not yet collected don't count); past it the oldest goes
export const CLEAN_MS = 1800;              // pausing at the table
export const STALL_CLEAN_MS = 5000;        // scrubbing an overflowed stall takes longer
export const STALL_LINGER_MS = 20_000;     // a stall stays out of order this long before she turns up
const STALL = 'stall:';
export const PET_MS = 2000;                // the hearts
export const PET_FOLLOW_MS = 60_000;       // then it tags along with the person
export const BAT_CHANCE = 0.7;             // per try
export const BAT_COOLDOWN_MS = 1000;
export const BAT_RESPAWN_MS = 10 * 60_000; // after a catch
export const SAY_MS = 5000;                // a phrase stays up this long
export const CAT_JUDGE_COOLDOWN_MS = 30_000;
export const PAW_MS = 2400;                // the cat dabs at the water…
export const SHAKE_MS = 1600;              // …the dog comes out of it and shakes off
const TALKERS: Partial<Record<CreatureKind, Speaker>> = { cleaner: 'cleaner', cat: 'cat', dog: 'dog' }; // who has lines in shared/phrases.ts
const SPEED: Record<CreatureKind, number> = { cat: 320, dog: 230, bat: 150, cleaner: 300 };

export interface CreatureHost {
  map(): TileMap;
  broadcast(msg: ServerMsg): void;
  people(): Tile[]; // where people (and bots) stand in the office right now
  personTile?(userId: string): Tile | null; // where this person is headed in the office, if they're about
  drunkPeople?(now: number): { id: string; tile: Tile }[]; // visible humans with an active cocktail/GM effect
  fullStalls?(): { id: string; door: Tile }[]; // out-of-order toilet stalls with nobody inside, and the tile at their door
  cleanStall?(id: string): void;               // the cleaner has scrubbed it: back in order
}
interface Live extends Creature {
  until: number;                                   // busy (walking, sitting, napping…) until then
  then?: { pose: CreaturePose; ms: number }; // what to do on arrival
  cleaning?: string;                          // the cleaner: the cup (or `stall:<id>`) she's on her way to (or wiping up)
  humUntil?: number; sayUntil?: number; nextSayAt?: number; // the cleaner's humming stretch; a phrase, when the next one comes
  follow?: { userId: string; until: number }; // a petted cat or dog trots after its person for a while
  judging?: string; judgeAfter?: number; // the cat's next visitor to lecture, and a pause between lectures
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const N4: Tile[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
const inOctober = (d: Date) => d.getMonth() === 9;

export const wetAt = (m: TileMap, t: Tile) => { const k = terrainAt(m, t.x, t.y); return k === 'shallow' || k === 'deep' ? k : null; };
/** The cat never sets foot in water; the dog paddles in the shallows but stays in its depth. */
export const tooWet = (kind: CreatureKind, m: TileMap, t: Tile) => kind === 'cat' ? !!wetAt(m, t) : kind === 'dog' && wetAt(m, t) === 'deep';
const grounds = new WeakMap<TileMap, Partial<Record<CreatureKind, TileMap>>>();
/** The map as this creature's paws see it: water it won't go in is a wall (a new layout is a new map, so a new copy). */
export function groundFor(m: TileMap, kind: CreatureKind): TileMap {
  if (kind !== 'cat' && kind !== 'dog') return m;
  let byKind = grounds.get(m);
  if (!byKind) grounds.set(m, byKind = {});
  return byKind[kind] ??= { ...m, layers: { ...m.layers, walkable: m.layers.walkable.map((row, y) => row.map((v, x) => v === 1 && tooWet(kind, m, { x, y }) ? 0 : v)) } };
}

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
  private ground(c: Live) { return groundFor(this.map, c.kind); }
  toPublic = (c: Live): Creature => ({ id: c.id, kind: c.kind, name: c.name, tile: c.tile, dir: c.dir, pose: c.pose, walk: c.walk, ...(c.hum ? { hum: true } : {}), ...(c.say ? { say: c.say } : {}) });
  all() { return [...this.list.values()].map(this.toPublic); }
  private announceAll() { this.host.broadcast({ t: 'creatures', creatures: this.all() }); }
  private announce(c: Live) { this.host.broadcast({ t: 'creature', creature: this.toPublic(c), by: c.pose === 'pet' ? c.follow?.userId : undefined }); }
  private announceCups() { this.host.broadcast({ t: 'cups', cups: this.cups }); }

  add(kind: CreatureKind, name: string, tile: Tile) {
    const c: Live = { id: `${kind}`, kind, name, tile: { ...tile }, dir: 'down', pose: kind === 'bat' ? 'hang' : 'idle', walk: null, until: 0 };
    this.list.set(c.id, c); this.announceAll();
    return c;
  }
  remove(id: string) { if (this.list.delete(id)) this.announceAll(); }

  /** Walk (or fly) somewhere; on arrival take up `then`. False if there's no way there. */
  go(c: Live, to: Tile, now: number, then?: Live['then'], path = c.kind === 'bat' ? flightPath(c.tile, to) : findPath(this.ground(c), c.tile, to)) {
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

  // ---------- cups & props ----------
  // One saved layer for everything placed in the world (a `Cup` is a prop: item, tile, owner `by`, optional `ttl`). Cups, plates
  // and thrown items all live here; the cleaner tidies any of them once they've lingered.
  /** The table (or desk, or counter) under this tile, if a cup can go on it. */
  tableAt(t: Tile) { return cupTableAt(this.map.objects, t); }
  cupProblem(t: Tile, item = '', floor = false): string | null {
    const plate = isPlate(item);
    if (!floor && !this.tableAt(t)) return plate ? 'Plates go on a table' : 'Cups go on a table';
    if (this.cups.some(c => c.tile.x === t.x && t.y === c.tile.y)) return 'There\'s a cup there already';
    if (!floor && this.cups.filter(c => isPlate(c.item) === plate && !isToy(c.item)).length >= (plate ? MAX_PLATES : MAX_CUPS)) return plate ? 'The tables are full of plates: wait for the cleaner' : 'The tables are full of cups: wait for the cleaner';
    return null;
  }
  /** Walkable tiles touching this tile, from where you can reach across to it. */
  beside(t: Tile, m = this.map) { return N4.map(d => ({ x: t.x + d.x, y: t.y + d.y })).filter(p => isWalkable(m, p.x, p.y)); }
  /** Put a cup down. floor: dropped where someone stands (any tile); nobody chooses to drop, so instead of refusing
   *  a full floor the oldest cup vanishes. by: who left it. */
  addCup(t: Tile, item: string, now: number, opts: { floor?: true; by?: string; ttl?: number } = {}): Cup | string {
    const problem = this.cupProblem(t, item, !!opts.floor);
    if (problem) return problem;
    let cups = this.cups;
    const litter = (c: Cup) => !isPlate(c.item) && !isToy(c.item); // toys live apart from the cup limit
    if (opts.floor && !isToy(item)) while (cups.filter(litter).length >= MAX_CUPS) { const oldest = cups.filter(litter).sort((a, b) => a.at - b.at)[0]; cups = cups.filter(c => c !== oldest); }
    if (isToy(item)) while (cups.filter(c => isToy(c.item) && c.by !== SPAWN_BY).length >= MAX_TOYS) { const oldest = cups.filter(c => isToy(c.item) && c.by !== SPAWN_BY).sort((a, b) => a.at - b.at)[0]; cups = cups.filter(c => c !== oldest); }
    const cup: Cup = { id: `cup${now.toString(36)}${(this.seq++).toString(36)}`, tile: { x: t.x, y: t.y }, item, at: now, ...(opts.floor ? { floor: true as const } : {}), ...(opts.by ? { by: opts.by } : {}), ...(opts.ttl ? { ttl: opts.ttl } : {}) };
    this.cups = [...cups, cup]; this.announceCups();
    return cup;
  }
  /** A remote car moved: its prop changes in place and clients get the small `car` message, not the whole layer. Returns the new prop. */
  moveCar(id: string, tile: Tile, dir: Dir): Cup | null {
    const i = this.cups.findIndex(c => c.id === id); if (i < 0) return null;
    const car: Cup = { ...this.cups[i], tile: { x: tile.x, y: tile.y }, dir };
    this.cups = this.cups.map((c, j) => (j === i ? car : c));
    this.host.broadcast({ t: 'car', id, tile: car.tile, dir });
    return car;
  }
  removeCup(id: string) {
    const before = this.cups.length;
    this.cups = this.cups.filter(c => c.id !== id);
    if (this.cups.length !== before) this.announceCups();
  }

  // ---------- behaviour ----------
  tick(now: number, date = new Date(now)) {
    for (const cup of this.cups) if (now - cup.at > (cup.ttl ?? CUP_TTL_MS)) this.removeCup(cup.id);
    const bat = this.list.get('bat');
    if (bat && !this.batSeason(date)) this.remove('bat');
    for (const c of this.list.values()) {
      if (c.kind === 'cat' && this.judge(c, now)) { this.voice(c, now); continue; }
      if (TALKERS[c.kind]) this.voice(c, now);
      if (now < c.until) continue;
      if (c.then) { // just arrived
        const gone = c.cleaning && !this.stillDirty(c.cleaning);
        if (!gone) {
          const pose = c.then.pose;
          this.settle(c, pose, c.then.ms, now);
          if (pose === 'shake') this.sayNow(c, phrase('dog', 'shake'), now);
          continue;
        }
        c.then = undefined; c.walk = null; c.cleaning = undefined; // someone beat her to it
      }
      if (c.kind === 'cleaner') this.cleaner(c, now);
      else if (c.kind === 'bat') this.flutter(c, now);
      else if (c.pose === 'paw') this.backOff(c, now);
      else if (c.follow && this.followPerson(c, now)) continue;
      else if (c.kind === 'dog' && wetAt(this.map, c.tile)) this.wadeOut(c, now);
      else this.wander(c, now);
    }
  }
  batSeason(d: Date) { return this.batAlways || inOctober(d); }

  /** The cat wakes for a tipsy human, walks over, then delivers its verdict face to face. */
  private judge(c: Live, now: number) {
    if ((c.walk && now < c.until) || (c.pose === 'pet' && now < c.until) || (c.follow && now < c.follow.until)
      || (c.sayUntil && now < c.sayUntil) || now < (c.judgeAfter ?? 0)) return false;
    const people = this.host.drunkPeople?.(now) ?? [];
    const distance = (t: Tile) => Math.abs(t.x - c.tile.x) + Math.abs(t.y - c.tile.y);
    const targets = c.judging ? people.filter(p => p.id === c.judging) : people.sort((a, b) => distance(a.tile) - distance(b.tile));
    if (!targets.length) { c.judging = undefined; return false; }
    const taken = new Set(this.host.people().map(p => `${p.x},${p.y}`));
    for (const target of targets) {
      if (distance(target.tile) === 1) {
        c.judging = undefined; c.judgeAfter = now + CAT_JUDGE_COOLDOWN_MS;
        c.dir = dirBetween(c.tile, target.tile, c.dir);
        this.settle(c, 'sit', SAY_MS + 1500, now);
        this.sayNow(c, phrase('cat', 'judge'), now);
        return true;
      }
      const paths = this.beside(target.tile, this.ground(c)).filter(p => !taken.has(`${p.x},${p.y}`))
        .map(p => ({ spot: p, path: findPath(this.ground(c), c.tile, p) })).filter(p => p.path.length)
        .sort((a, b) => a.path.length - b.path.length);
      const plan = paths[0];
      if (plan) { c.judging = target.id; return this.go(c, plan.spot, now, undefined, plan.path); }
    }
    c.judging = undefined; c.judgeAfter = now + 5000; // an unreachable guest must not turn into a pathfinding loop
    return false;
  }

  // ---------- petting and catching ----------
  /** A pat for the cat or dog: hearts for a moment, then it follows that person about for a minute. */
  petBy(c: Live, userId: string, now: number) {
    c.follow = { userId, until: now + PET_FOLLOW_MS };
    this.settle(c, 'pet', PET_MS, now);
    this.sayNow(c, phrase(c.kind === 'cat' ? 'cat' : 'dog', 'pet'), now);
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
    const spots = this.beside(at, this.ground(c)).filter(p => !taken.has(`${p.x},${p.y}`));
    if (spots.length && this.go(c, pick(spots), now, { pose: 'sit', ms: 1500 })) return true;
    c.follow = undefined; return false;
  }

  /** Cat and dog: trot over to someone and sit by them, potter about a room, or curl up for a nap. */
  private wander(c: Live, now: number) {
    const people = this.host.people(), r = Math.random(), dog = c.kind === 'dog';
    if (people.length && r < (dog ? 0.55 : 0.35)) {
      const near = pick(people), taken = new Set(people.map(p => `${p.x},${p.y}`));
      const spots = this.beside(near, this.ground(c)).filter(p => !taken.has(`${p.x},${p.y}`));
      if (spots.length && this.go(c, pick(spots), now, { pose: 'sit', ms: rand(12_000, 35_000) })) return;
    }
    if (r < (dog ? 0.85 : 0.65)) {
      const room = pick(this.map.rooms.filter(r => r.id !== 'meeting'));
      for (let i = 0; i < 12; i++) {
        const x = room.rect.x + Math.floor(Math.random() * room.rect.w), y = room.rect.y + Math.floor(Math.random() * room.rect.h);
        if (c.kind === 'cat' && wetAt(this.map, { x, y })) { if (this.testWater(c, { x, y }, now)) return; continue; }
        if (isWalkable(this.ground(c), x, y) && this.go(c, { x, y }, now, { pose: 'idle', ms: rand(2000, 8000) })) return;
      }
    }
    this.settle(c, 'nap', dog ? rand(20_000, 50_000) : rand(30_000, 90_000), now);
  }
  /** The first dry, walkable tile up the shore from a tile in the water (the sea lies south), and the water below it. */
  private shore(c: Live, t: Tile) {
    const m = this.ground(c);
    for (let y = t.y - 1; y >= 0; y--) {
      if (!wetAt(this.map, { x: t.x, y })) return isWalkable(m, t.x, y) && wetAt(this.map, { x: t.x, y: y + 1 }) ? { x: t.x, y } : null;
    }
    return null;
  }
  /** The cat fancied a spot in the water: it goes to the edge instead and dabs at it with a paw. */
  private testWater(c: Live, t: Tile, now: number) {
    const edge = this.shore(c, t);
    if (!edge || !this.go(c, edge, now, { pose: 'paw', ms: PAW_MS })) return false;
    c.dir = 'down'; return true;
  }
  /** …and thinks better of it: a few steps back up the beach, a word about it, a sit. */
  private backOff(c: Live, now: number) {
    this.sayNow(c, phrase('cat', 'water'), now);
    const m = this.ground(c);
    for (let d = 4; d >= 1; d--) {
      const to = { x: c.tile.x, y: c.tile.y - d };
      if (isWalkable(m, to.x, to.y) && this.go(c, to, now, { pose: 'sit', ms: rand(4000, 9000) })) return;
    }
    this.settle(c, 'sit', rand(4000, 9000), now);
  }
  /** The dog has had its paddle: out onto the sand, then a good shake. */
  private wadeOut(c: Live, now: number) {
    const edge = this.shore(c, c.tile);
    if (edge && this.go(c, edge, now, { pose: 'shake', ms: SHAKE_MS })) return;
    this.wander(c, now);
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
      if (c.cleaning?.startsWith(STALL)) this.host.cleanStall?.(c.cleaning.slice(STALL.length));
      else if (c.cleaning) this.removeCup(c.cleaning);
      c.cleaning = undefined;
      this.settle(c, 'idle', 0, now);
    }
    const plan = this.planClean(c.tile, now);
    if (plan) {
      c.cleaning = plan.cup.id;
      this.go(c, plan.spot, now, { pose: 'clean', ms: CLEAN_MS }, plan.path);
      return;
    }
    const stall = this.planStall(c.tile);
    if (stall) {
      c.cleaning = STALL + stall.id;
      this.go(c, stall.spot, now, { pose: 'clean', ms: STALL_CLEAN_MS }, stall.path);
      return;
    }
    this.roam(c, now);
  }
  /** Nothing to clean: stroll to a stand tile in a random room (not the admin room), pause, repeat, humming now and then. */
  private roam(c: Live, now: number) {
    const rooms = this.map.rooms.filter(r => r.rules.access !== 'admins');
    for (let i = 0; i < 8; i++) {
      const spot = pick(pick(rooms).stand.filter(s => isWalkable(this.map, s.x, s.y)));
      if (!spot || (spot.x === c.tile.x && spot.y === c.tile.y)) continue;
      if (!(c.humUntil && c.humUntil > now) && Math.random() < 0.5) c.humUntil = now + rand(15_000, 40_000);
      if (this.go(c, { x: spot.x, y: spot.y }, now, { pose: 'idle', ms: rand(3000, 7000) })) return;
    }
    c.until = now + 1000;
  }
  /** The cleaner's humming and anyone's occasional idle phrase: set and cleared by the clock, announced when they change.
   *  Nobody talks while wiping a table or asleep. */
  private voice(c: Live, now: number) {
    const busy = c.pose === 'clean' || c.pose === 'nap';
    const hum = !!c.humUntil && now < c.humUntil && c.pose !== 'clean', say = c.sayUntil && now < c.sayUntil ? c.say : undefined;
    c.nextSayAt ??= now + rand(60_000, 150_000);
    let nextSay = say;
    if (!say && now >= c.nextSayAt && !busy) { nextSay = phrase(TALKERS[c.kind]!, 'idle'); c.sayUntil = now + SAY_MS; c.nextSayAt = now + rand(120_000, 300_000); }
    if (hum !== !!c.hum || nextSay !== c.say) { c.hum = hum; c.say = nextSay; this.announce(c); }
  }
  /** Say this right away (an answer to something), and hold the next idle line off for a while. */
  private sayNow(c: Live, text: string, now: number) {
    c.say = text; c.sayUntil = now + SAY_MS; c.nextSayAt = now + rand(120_000, 300_000);
    this.announce(c);
  }
  /** Someone cleared a cup away themselves. If the cleaner is in that room right now (mid-walk counts where she is),
   *  she says so: true. */
  praise(roomId: string | undefined, now: number) {
    const c = [...this.list.values()].find(c => c.kind === 'cleaner');
    if (!c || !roomId) return false;
    const at = c.walk ? c.walk.path[Math.max(0, Math.min(c.walk.path.length - 1, Math.floor((now - c.walk.startedAt) / c.walk.ms)))] : c.tile;
    if (roomAt(this.map, at.x, at.y)?.id !== roomId) return false;
    this.sayNow(c, phrase('cleaner', 'praise'), now);
    return true;
  }
  /** Someone handed her their empty cup: she says thanks (wherever she is). */
  thank(now: number) {
    const c = [...this.list.values()].find(c => c.kind === 'cleaner');
    if (c) this.sayNow(c, phrase('cleaner', 'thanks'), now);
  }
  private stillDirty(target: string) {
    return target.startsWith(STALL) ? !!this.host.fullStalls?.().some(s => s.id === target.slice(STALL.length)) : this.cups.some(k => k.id === target);
  }
  /** An out-of-order stall (nobody inside) and where to stand at its door: the nearest by path. Cups come first. */
  planStall(from: Tile) {
    let best: { id: string; spot: Tile; path: Tile[] } | null = null;
    for (const st of this.host.fullStalls?.() ?? []) {
      const path = findPath(this.map, from, st.door);
      if (path.length && (!best || path.length < best.path.length)) best = { id: st.id, spot: st.door, path };
    }
    return best;
  }
  /** Which cup next and where to stand for it: litter on the floor first (she stands on it), then the nearest by path. */
  planClean(from: Tile, now: number) {
    let best: { cup: Cup; spot: Tile; path: Tile[] } | null = null;
    for (const cup of this.cups) {
      if (isToy(cup.item)) continue; // toys stay where their owner left them
      if (now - cup.at < CUP_LINGER_MS + (isPlate(cup.item) ? LUNCH_MS : 0)) continue; // a plate stays while its owner eats
      if (best?.cup.floor && !cup.floor) continue;
      const spots = cup.floor && isWalkable(this.map, cup.tile.x, cup.tile.y) ? [cup.tile] : this.beside(cup.tile);
      for (const spot of spots) {
        const path = findPath(this.map, from, spot);
        if (path.length && (!best || (cup.floor && !best.cup.floor) || path.length < best.path.length)) best = { cup, spot: { ...spot }, path };
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
    c.add('cleaner', 'Cleaning lady', c.base());
  }
  setInterval(() => {
    const now = Date.now();
    if (pets) c.wantBat(now);
    c.tick(now);
  }, 500).unref();
}
