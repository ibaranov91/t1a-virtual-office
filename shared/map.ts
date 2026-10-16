import type { RetroGameId } from './retro/games';
import type { InstrumentKind } from './instruments';
import type { LayoutEdit } from './protocol';

// Shared floor logic: used by the server AND every client, so paths are identical everywhere.

export type Dir = 'down' | 'left' | 'right' | 'up';
export interface Tile { x: number; y: number }
export interface Rect extends Tile { w: number; h: number }
export interface Spot extends Tile { dir: Dir }
export type KnockRule = 'allow' | 'disabled' | 'later';
export interface Room {
  id: string; name: string; type: string;
  rect: Rect;
  capacity: number; floor: string; rug: string;
  stand: Spot[];  // standing spots (no furniture); `spots` adds every seat, so it follows the furniture
  spots: Spot[];
  homeDesks?: boolean; // seats here can be claimed as someone's home desk
  plantSlots?: Tile[];  // where plants of people without a home desk stand (the Orangery's shelves)
  disco?: { x: number; y: number }; // a disco ball comes out here in the evening: the floor point under it, in tiles
  rules: { voice?: 'open'; knock: KnockRule; label?: string; occupantLabel?: string; access?: 'admins' }; // access: only office admins walk in
  meeting: { provider: 'meet' | 'teams'; url: string };
}
/** Something you can hold for a while, taken from an object (a coffee from the machine). */
export interface UseItem { id: string; label: string; icon: string }
/** What clicking an object offers: take something from it, flip it on/off, or look at your calendar on it. */
export type ObjectUse = { kind: 'take'; items: UseItem[] } | { kind: 'toggle'; label: string } | { kind: 'calendar'; label: string }
  | { kind: 'instrument'; instrument: InstrumentKind; label: string }
  | { kind: 'jukebox'; label: string; genres?: string[] } // genres: play only these (the club's DJ booth); without it, everything but the club-only genres
  | { kind: 'youtube'; label: string; room: string }
  | { kind: 'dance'; label: string } // Berghain's dance floor: step on and dance
  | { kind: 'library'; label: string } // the Library's shelf: publish and pick articles; reading happens at its reading tables
  | { kind: 'table'; label: string }
  | { kind: 'retro'; label: string; game: RetroGameId }
  | { kind: 'arcade'; label: string; game: 'park' } | { kind: 'records'; label: string }
  | { kind: 'meetings'; label: string } // the board by the Meeting room: which calendar meetings are on
  | { kind: 'achievements'; label: string } // the Lobby notice board: your plant and your badges
  | { kind: 'clock'; label: string; city: string; tz: string } // a Lobby wall clock (real time, one city); clicking opens the list of our cities
  | { kind: 'presentation'; label: string } // the Meeting room screen: upload slides and present them
  | { kind: 'room_start'; label: string } // the Meeting room's wall sign: start a private room
  | { kind: 'link'; label: string; url: string } // opens a page in a new tab (the safe: the vault)
  | { kind: 'dealer'; label: string; items: string[] } // hands out items into your inventory (the bouncer, the hat stand)
  | { kind: 'bell'; label: string } // the Lobby reception bell: ring it from beside the desk
  | { kind: 'vacations' }
  | { kind: 'toilet'; label: string }; // a stall: occupied for a while, fills up with use (see Toilets on the server)
export type UseKind = ObjectUse['kind'];
/** How a click on each use.kind is routed. A new kind fails typecheck until it has a row (docs/ADDING-A-FEATURE.md).
 *  wheel: clicking opens App.tsx's ActionWheel (add its buttons there); otherwise App.tsx's `e.onPick` acts on the click
 *    straight away (add a line there). use: the server's generic `use` intent handles it (World.use: walk beside it, wait
 *    USE_MS, act); otherwise `use` ignores it (it has its own intent, or it's a client-only panel). reach: people walk up
 *    to it, so layoutProblem refuses a layout that leaves no free tile beside it. */
export const USE_KINDS = {
  take: { wheel: true, use: true, reach: true },
  toggle: { wheel: true, use: true, reach: true },
  toilet: { wheel: true, use: true }, // reached through its door instead: layoutProblem checks stallDoor
  dealer: { wheel: true, use: true },
  bell: { use: true },
  arcade: { use: true, reach: true },
  table: { use: true, reach: true },
  retro: { use: true, reach: true },
  instrument: { reach: true },
  library: { reach: true },
  vacations: {}, calendar: {}, jukebox: {}, youtube: {}, dance: {}, records: {}, meetings: {}, achievements: {}, clock: {}, link: {},
  presentation: { use: true, reach: true }, // walk to the board first; the panel opens on arrival
  room_start: { use: true, reach: true }, // the Meeting room's wall sign: walk over, then the server offers a private room
} as const satisfies Record<UseKind, { wheel?: true; use?: true; reach?: true }>;
type KindsWith<F extends string> = { [K in UseKind]: (typeof USE_KINDS)[K] extends Record<F, true> ? K : never }[UseKind];
/** True when this use's kind has that flag in USE_KINDS; narrows the use to those kinds. */
export const routes = <F extends 'wheel' | 'use' | 'reach'>(use: ObjectUse | undefined, flag: F): use is Extract<ObjectUse, { kind: KindsWith<F> }> =>
  !!use && (USE_KINDS[use.kind] as Partial<Record<F, true>>)[flag] === true;
export interface MapObject {
  id: string; type: string; x: number; y: number; w: number; h: number;
  sound?: { gain: number };
  wall?: boolean; walkable?: boolean; light?: boolean; steam?: boolean; dir?: Dir;
  use?: ObjectUse; on?: boolean; // on: starting state of a toggle
  onTop?: boolean; // sits on top of another object (the reception bell): allowed to share its tile
  turned?: boolean; // a chair or stool an admin rotated: keeps its `dir` instead of facing the nearest furniture
  lie?: boolean; // one seat at the top-row centre; the rest of the footprint blocks
  sit?: boolean; // a sofa: blocks walking, but every tile is a seat facing `dir`, reached from the tile in front
}
/** A rug, drawn over the floor (9-slice). Never blocks. */
export interface Rug { id: string; color: string; pattern?: string; x: number; y: number; w: number; h: number } // pattern: one of RUG_PATTERNS, diamond when missing
export const RUG_COLORS = ['green', 'blue', 'orange', 'red', 'teal', 'burgundy'] as const;
export const RUG_PATTERNS = ['diamond', 'stripes', 'checks', 'dots', 'zigzag', 'plaid', 'plain'] as const;
/** The atlas frame of one rug tile (`part` is n, se, c…); diamond keeps the original frame names. */
export const rugFrame = (r: Pick<Rug, 'color' | 'pattern'>, part: string) => !r.pattern || r.pattern === 'diamond' ? `rug_${r.color}_${part}` : `rug_${r.color}_${r.pattern}_${part}`;
/** What office admins can rearrange: the furniture and the rugs. Walls, floors and rooms stay as generated. */
export interface Layout { objects: MapObject[]; rugs: Rug[] }
/** A kind of object an admin can add: everything but its id and position. */
export type ObjectTemplate = Omit<MapObject, 'id' | 'x' | 'y'>;
export interface TileMap {
  version: number; width: number; height: number; tileSize: number;
  office: Rect;
  dungeon?: {
    rect: Rect; hole: Tile; hatch: Tile; landing: Tile; door: Rect; doorFront: Tile;
    keySpots: Tile[]; torches: Tile[]; decor: { type: string; x: number; y: number }[];
  };
  vacation?: { gate: Tile; trailFoot: Tile; summit: Tile; pierEnds: [Tile, Tile]; swim: Tile[] };
  tiles: string[];
  layers: { floor: number[][]; walls: number[][]; walkable: number[][] };
  rooms: Room[]; objects: MapObject[]; rugs: Rug[]; spawn: Tile;
  exit: Tile; // where people walk to leave, and appear when they come back
  catalog: Record<string, ObjectTemplate>; // one of each kind of object, as generated
}

export const WALK_MS_PER_TILE = 250; // 4 tiles/s

export const SEAT_TYPES = new Set(['chair', 'stool']);
/**
 * Per-tile lookups, built once per map: the map is read many times a frame (every sprite, every path), so
 * walkable/room/seat are flat typed arrays indexed by `y * width + x` instead of scans over rooms and objects.
 * `g`, `came` and `seen` are A*'s scratch space, reused across calls (`seen` holds a generation stamp, so
 * nothing is cleared between searches).
 */
interface MapIndex {
  walk: Uint8Array; room: Int8Array; seat: Int16Array; byId: Map<string, MapObject>;
  locked: Uint8Array; // 1 in rooms only admins may enter
  g: Int32Array; came: Int32Array; seen: Uint32Array; gen: number;
}
const indexes = new WeakMap<TileMap, MapIndex>();
/** Maps are read-only once in use; after editing one (tests), drop its index so the next lookup rebuilds it. */
const doorways = new WeakMap<TileMap, Map<Room, Tile[][]>>(); // doorwayTiles' groups
export const reindexMap = (m: TileMap) => { indexes.delete(m); doorways.delete(m); };
export function mapIndex(m: TileMap): MapIndex {
  let ix = indexes.get(m);
  if (ix) return ix;
  const n = m.width * m.height;
  const walk = new Uint8Array(n), room = new Int8Array(n).fill(-1), seat = new Int16Array(n).fill(-1), locked = new Uint8Array(n);
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) walk[y * m.width + x] = m.layers.walkable[y][x] === 1 ? 1 : 0;
  m.rooms.forEach((r, i) => {
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
      room[y * m.width + x] = i; if (r.rules.access === 'admins') locked[y * m.width + x] = 1;
    }
  });
  m.objects.forEach((o, i) => { // first match wins, like the old `find`
    if (o.lie) { const k = o.y * m.width + o.x + Math.floor((o.w - 1) / 2); if (seat[k] < 0) seat[k] = i; }
    else if (SEAT_TYPES.has(o.type)) { const k = o.y * m.width + o.x; if (seat[k] < 0) seat[k] = i; }
    else if (o.sit) for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) { const k = y * m.width + x; if (seat[k] < 0) seat[k] = i; }
  });
  ix = { walk, room, seat, locked, byId: new Map(m.objects.map(o => [o.id, o])), g: new Int32Array(n), came: new Int32Array(n), seen: new Uint32Array(n), gen: 0 };
  indexes.set(m, ix);
  return ix;
}

export const isWalkable = (m: TileMap, x: number, y: number) =>
  x >= 0 && y >= 0 && x < m.width && y < m.height && mapIndex(m).walk[y * m.width + x] === 1;

export const roomAt = (m: TileMap, x: number, y: number): Room | undefined => {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return undefined;
  const i = mapIndex(m).room[y * m.width + x];
  return i < 0 ? undefined : m.rooms[i];
};

/** In a room only office admins may walk into (the Admin room). */
export const adminOnly = (m: TileMap, x: number, y: number) =>
  x >= 0 && y >= 0 && x < m.width && y < m.height && mapIndex(m).locked[y * m.width + x] === 1;

export const objectById = (m: TileMap, id: string) => mapIndex(m).byId.get(id);

// Deterministic 4-neighbour A*. Returns tiles from `from` to `to` inclusive, or [] if unreachable.
// keepOut: not an admin, so admins-only rooms aren't walkable (someone already inside may still walk out).
const NEIGH: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export function findPath(m: TileMap, from: Tile, to: Tile, keepOut = false): Tile[] {
  if (!isWalkable(m, to.x, to.y)) return [];
  if (keepOut && adminOnly(m, to.x, to.y)) return [];
  if (keepOut && adminOnly(m, from.x, from.y)) keepOut = false;
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const W = m.width, key = (x: number, y: number) => y * W + x;
  const ix = mapIndex(m), walk = ix.walk, locked = ix.locked, gen = ++ix.gen;
  if (gen === 0xffffffff) { ix.seen.fill(0); ix.gen = 1; }
  // g/came are valid for a tile only while seen[tile] === gen
  const gAt = (k: number) => (ix.seen[k] === gen ? ix.g[k] : Infinity);
  const set = (k: number, gv: number, from: number) => { ix.seen[k] = gen; ix.g[k] = gv; ix.came[k] = from; };
  const h = (x: number, y: number) => Math.abs(x - to.x) + Math.abs(y - to.y);
  // binary heap of [f, h, seq, key]; seq makes ordering fully deterministic
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (a: typeof heap[0], b: typeof heap[0]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const push = (n: typeof heap[0]) => {
    heap.push(n); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p]) >= 0) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let s = i;
        if (l < heap.length && less(heap[l], heap[s]) < 0) s = l;
        if (r < heap.length && less(heap[r], heap[s]) < 0) s = r;
        if (s === i) break; [heap[i], heap[s]] = [heap[s], heap[i]]; i = s;
      }
    }
    return top;
  };
  const start = key(from.x, from.y), goal = key(to.x, to.y);
  set(start, 0, -1); push([h(from.x, from.y), h(from.x, from.y), seq++, start]);
  while (heap.length) {
    const [, , , k] = pop();
    if (k === goal) break;
    const cx = k % W, cy = (k / W) | 0, cg = ix.g[k];
    for (const [dx, dy] of NEIGH) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= m.height) continue;
      const nk = key(nx, ny);
      if (walk[nk] !== 1 || (keepOut && locked[nk])) continue;
      const ng = cg + 1;
      if (ng < gAt(nk)) {
        set(nk, ng, k);
        const hh = h(nx, ny); push([ng + hh, hh, seq++, nk]);
      }
    }
  }
  if (ix.seen[goal] !== gen) return [];
  const out: Tile[] = [];
  for (let k = goal; k >= 0; k = ix.came[k]) {
    out.push({ x: k % W, y: (k / W) | 0 });
    if (k === start) break;
  }
  return out.reverse();
}

export interface Move { from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir; ms?: number } // ms: per tile (speed effects)

export const dirBetween = (a: Tile, b: Tile, fallback: Dir = 'down'): Dir =>
  b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : b.y < a.y ? 'up' : fallback;

/** Interpolated position along a path at time t. `x,y` are fractional tiles. */
export function sampleMove(path: Tile[], startedAt: number, t: number, ms = WALK_MS_PER_TILE) {
  if (path.length === 0) return null;
  const elapsed = Math.max(0, t - startedAt);
  const seg = elapsed / ms;
  const i = Math.floor(seg);
  if (i >= path.length - 1) {
    const last = path[path.length - 1];
    const prev = path[path.length - 2] ?? last;
    return { x: last.x, y: last.y, dir: dirBetween(prev, last), done: true, tile: last, next: last };
  }
  const a = path[i], b = path[i + 1], f = seg - i;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dir: dirBetween(a, b), done: false, tile: f < 0.5 ? a : b, next: b };
}

const TURN: Record<Dir, Dir> = { down: 'left', left: 'up', up: 'right', right: 'down' }; // a quarter turn clockwise
const STEP: Record<Dir, Tile> = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
/** Path to `to`. Sofa seats aren't walkable: you sit down onto one from the tile in front, and get up the same way. */
export function pathTo(m: TileMap, from: Tile, to: Tile, keepOut = false): Tile[] {
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const front = (t: Tile) => {
    if (isWalkable(m, t.x, t.y)) return null;
    const s = seatAt(m, t.x, t.y);
    return s && { x: t.x + STEP[s.dir].x, y: t.y + STEP[s.dir].y };
  };
  const up = front(from), down = front(to);
  if (!isWalkable(m, to.x, to.y) && !down) return [];
  if (keepOut && adminOnly(m, to.x, to.y)) return [];
  const mid = findPath(m, up ?? from, down ?? to, keepOut);
  if (!mid.length) return [];
  return [...(up ? [{ ...from }] : []), ...mid, ...(down ? [{ ...to }] : [])];
}

export const pathDuration = (path: Tile[], ms = WALK_MS_PER_TILE) => Math.max(0, path.length - 1) * ms;

/** Free walkable tiles touching an object's footprint, each with the direction that faces the object. */
export function besideObject(m: TileMap, o: MapObject): Spot[] {
  const out: Spot[] = [];
  for (let x = o.x; x < o.x + o.w; x++) { out.push({ x, y: o.y + o.h, dir: 'up' }); out.push({ x, y: o.y - 1, dir: 'down' }); }
  for (let y = o.y; y < o.y + o.h; y++) { out.push({ x: o.x - 1, y, dir: 'right' }); out.push({ x: o.x + o.w, y, dir: 'left' }); }
  return out.filter(t => isWalkable(m, t.x, t.y));
}

/** A toilet stall's door: the tile in front of its left half (stalls stand against a wall, door facing the room). */
export const stallDoor = (o: MapObject): Tile => ({ x: o.x, y: o.y - 1 });
/** Everyone inside a stall shares its own voice, a hall like Coffee's but only for the people behind that door. */
export const STALL_VOICE = 'room:stall:';
export const stallVoiceId = (objectId: string) => STALL_VOICE + objectId;
export const stallOfCall = (callId?: string | null) => callId?.startsWith(STALL_VOICE) ? callId.slice(STALL_VOICE.length) : undefined;
/** Where the line for a stall stands: straight out from the door, first in line nearest. */
export function stallLine(m: TileMap, o: MapObject, n: number): Spot[] {
  const door = stallDoor(o), out: Spot[] = [];
  for (let y = door.y - 1; out.length < n && y >= 0 && isWalkable(m, door.x, y); y--) out.push({ x: door.x, y, dir: 'down' });
  while (out.length < n) out.push(out.at(-1) ?? { ...door, dir: 'down' }); // a long line bunches up at its end
  return out;
}

/** Seat (chair/stool) on this tile, with the direction a sitter faces. */
export function seatAt(m: TileMap, x: number, y: number): (Spot & { homeDesk: boolean; type: string }) | null {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return null;
  const i = mapIndex(m).seat[y * m.width + x];
  if (i < 0) return null;
  const o = m.objects[i];
  return { x, y, dir: o.dir ?? 'down', homeDesk: o.type === 'chair' && !!roomAt(m, x, y)?.homeDesks, type: o.type };
}

export const voiceRooms = (m: TileMap) => m.rooms.filter(r => r.rules.voice === 'open');
export function doorwayTiles(m: TileMap, room: Room): Tile[][] {
  let rooms = doorways.get(m);
  if (!rooms) doorways.set(m, rooms = new Map());
  const cached = rooms.get(room); if (cached) return cached;
  const seen = new Set<string>(), groups: Tile[][] = [];
  const outside = (x: number, y: number) => isWalkable(m, x, y) && !roomAt(m, x, y);
  const { x, y, w, h } = room.rect;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (!isWalkable(m, xx, yy) && !seatAt(m, xx, yy)) continue;
    for (const [dx, dy] of NEIGH) {
      const start = { x: xx + dx, y: yy + dy }, key = `${start.x},${start.y}`;
      if (!outside(start.x, start.y) || seen.has(key)) continue;
      const group = [start]; seen.add(key);
      for (let i = 0; i < group.length; i++) for (const [dx, dy] of NEIGH) {
        const x = group[i].x + dx, y = group[i].y + dy, key = `${x},${y}`;
        if (outside(x, y) && !seen.has(key)) { seen.add(key); group.push({ x, y }); }
      }
      groups.push(group);
    }
  }
  rooms.set(room, groups); return groups;
}

// ---------- layout: what the furniture decides ----------
export const inRect = (o: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;
const footprint = (o: { x: number; y: number; w: number; h: number }) => {
  const out: Tile[] = [];
  for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) out.push({ x, y });
  return out;
};

/** Put this furniture and these rugs on the floor and work out what follows: where you can walk, which way each
 *  chair faces, every room's seats, the Orangery's plant slots. The server and every client run this on the same
 *  layout, so paths stay identical everywhere. */
export function applyLayout(m: TileMap, l: Layout) {
  m.objects = l.objects; m.rugs = l.rugs;
  const { walls } = m.layers;
  const walkable = walls.map(row => row.map(w => (w ? 0 : 1)));
  for (const o of m.objects) if (!o.wall && !o.walkable) for (const t of footprint(o)) if (walkable[t.y]?.[t.x] !== undefined) walkable[t.y][t.x] = 0;
  m.layers.walkable = walkable;
  reindexMap(m); // the lookups below must see the new floor
  const free = (x: number, y: number) => walkable[y]?.[x] === 1;
  for (const r of m.rooms) { r.spots = []; delete r.plantSlots; }
  for (const o of m.objects) {
    const r = roomAt(m, o.x, o.y);
    if (o.lie) { if (r) r.spots.push({ x: o.x + Math.floor((o.w - 1) / 2), y: o.y, dir: o.dir ?? 'down' }); continue; }
    if (o.sit) { if (r) for (let x = o.x; x < o.x + o.w; x++) r.spots.push({ x, y: o.y, dir: o.dir ?? 'down' }); continue; }
    if (o.type === 'plant_shelf') { if (r) for (let x = o.x; x < o.x + o.w; x++) (r.plantSlots ??= []).push({ x, y: o.y }); continue; }
    if (!SEAT_TYPES.has(o.type)) continue;
    // face the neighbouring furniture
    if (!o.turned) o.dir = !free(o.x, o.y - 1) && walls[o.y - 1]?.[o.x] === 0 ? 'up' : !free(o.x, o.y + 1) ? 'down' : !free(o.x + 1, o.y) ? 'right' : !free(o.x - 1, o.y) ? 'left' : 'down';
    if (r) r.spots.push({ x: o.x, y: o.y, dir: o.dir ?? 'down' });
  }
  for (const r of m.rooms) for (const s of r.stand) if (free(s.x, s.y) && !r.spots.some(p => p.x === s.x && p.y === s.y)) r.spots.push(s);
  reindexMap(m);
}

/** Why this layout won't do, or null if it's fine: furniture on the floor and decor on the walls, nothing on top of
 *  anything else, and the way in, every doorway, every seat and everything you can use still reachable. */
export function layoutProblem(m: TileMap, checkDungeonReach = true): string | null {
  const { walls, floor } = m.layers;
  const inside = (t: Tile) => inRect(m.office, t.x, t.y);
  const coversEntrance = (t: Tile) => m.dungeon && (['hole', 'hatch'] as const).find(k => m.dungeon![k].x === t.x && m.dungeon![k].y === t.y);
  for (const o of [...m.objects, ...m.rugs]) if (!inside(o) || !inside({ x: o.x + o.w - 1, y: o.y + o.h - 1 })) return "that's outside the office";
  const taken = new Map<string, string>();
  const claim = (key: string, what: string) => { const had = taken.get(key); taken.set(key, what); return had; };
  for (const o of m.objects) for (const t of footprint(o)) {
    const entrance = coversEntrance(t);
    if (entrance && !o.wall) return `that covers the ${entrance}`;
    if (o.wall ? !walls[t.y][t.x] : walls[t.y][t.x]) return o.wall ? `the ${objectName(o.type)} goes on a wall` : `the ${objectName(o.type)} can't stand in a wall`;
    const had = o.onTop ? undefined : claim(`${o.wall ? 'w' : 'f'}${t.x},${t.y}`, objectName(o.type));
    if (had) return `the ${objectName(o.type)} overlaps the ${had}`;
  }
  for (const r of m.rugs) for (const t of footprint(r)) {
    const entrance = coversEntrance(t);
    if (entrance) return `that covers the ${entrance}`;
    if (walls[t.y][t.x]) return 'a rug has to lie on the floor';
    if (claim(`r${t.x},${t.y}`, 'rug')) return 'rugs can\'t overlap';
  }
  const reached = new Set([`${m.spawn.x},${m.spawn.y}`]), queue = [m.spawn];
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of NEIGH) {
    const x = queue[i].x + dx, y = queue[i].y + dy, key = `${x},${y}`;
    if (isWalkable(m, x, y) && !reached.has(key)) { reached.add(key); queue.push({ x, y }); }
  }
  const ok = (t: Tile) => reached.has(`${t.x},${t.y}`);
  if (checkDungeonReach && m.dungeon) for (const k of ['hole', 'hatch'] as const) if (!ok(m.dungeon[k])) return `that blocks the ${k}`;
  if (!ok(m.exit)) return 'that blocks the way in';
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (m.tiles[floor[y][x]] === 'door_floor' && !walls[y][x] && !ok({ x, y })) return 'that blocks a doorway';
  }
  if (m.vacation) {
    const v = m.vacation, seen = new Set<string>(), q: Tile[] = [];
    if (isWalkable(m, v.gate.x, v.gate.y)) { seen.add(`${v.gate.x},${v.gate.y}`); q.push(v.gate); }
    for (let i = 0; i < q.length; i++) for (const [dx, dy] of NEIGH) {
      const x = q[i].x + dx, y = q[i].y + dy, key = `${x},${y}`;
      if (isWalkable(m, x, y) && !seen.has(key)) { seen.add(key); q.push({ x, y }); }
    }
    if (!ok(v.gate) || [v.trailFoot, v.summit, ...v.pierEnds, ...v.swim].some(t => !seen.has(`${t.x},${t.y}`))) return 'that blocks the way to the beach';
  }
  for (const r of m.rooms) for (const s of r.spots) {
    const sofa = m.objects.find(o => (o.sit || o.lie) && inRect(o, s.x, s.y));
    const step = sofa ? STEP[sofa.dir ?? 'down'] : { x: 0, y: 0 };
    if (!ok({ x: s.x + step.x, y: s.y + step.y })) return `that cuts off a seat in ${r.name}`;
  }
  // you walk over to these to use them (the calendars and boards just open)
  for (const o of m.objects) if (routes(o.use, 'reach') && !besideObject(m, o).some(ok)) return `nobody could reach the ${objectName(o.type)}`;
  for (const o of m.objects) if (o.use?.kind === 'toilet' && !ok(stallDoor(o))) return `nobody could get into the ${objectName(o.type)}`;
  return null;
}

/** What to call an object type in the UI: "big table", not table_big. */
export const objectName = (type: string) => ({ palm: 'palm', pine: 'pine', lounger: 'lounger', umbrella: 'umbrella', hammock: 'hammock', beach_bar: 'beach bar', vacation_sign: 'sign', summit_flag: 'flag', sandcastle: 'sandcastle', shells: 'shells', beach_ball: 'beach ball', retro_tobu: 'Tobu Tobu Girl', retro_lobster: 'Shock Lobster', table_long: 'long table', table_big: 'big table', table_round: 'round table', plant_shelf: 'plant shelf',
  painting_small: 'small painting', coffee_machine: 'coffee machine', meetings_board: 'meetings board', noticeboard: 'notice board', table_picnic: 'picnic table', food_cart: 'food cart', exit_door: 'exit door', server_rack: 'server rack', dj_booth: 'DJ booth', neon_sign: 'neon sign', bookshelf_tall: 'tall bookshelf' } as Record<string, string>)[type] ?? type.replace(/_/g, ' ');

/** Types that are one of a kind (the way out, the coffee machine…): they can be moved but not removed. */
export const KEEP_TYPES = new Set(['vacation_sign', 'lofi_tv', 'exit_door', 'coffee_machine', 'fridge', 'jukebox', 'arcade', 'game_table', 'retro_tobu', 'retro_lobster', 'records', 'meetings_board', 'noticeboard', 'clock_nyc', 'clock_berlin', 'clock_moscow', 'safe', 'keyboard', 'drum_kit', 'bass_amp', 'screen', 'room_start', 'toilet', 'bouncer', 'hat_rack', 'bell', 'food_cart', 'dj_booth']);;
/** Types that stay exactly where they are. */
export const FIXED_TYPES = new Set(['exit_door']);
export const RUG_MIN = 2, RUG_MAX = 24;

/** The layout after one admin edit, or why it can't be done. Checks the edit itself; `layoutProblem` checks the result. */
export function applyEdit(m: TileMap, edit: LayoutEdit, newId: () => string): Layout | string {
  const objects = m.objects.map(o => ({ ...o })), rugs = m.rugs.map(r => ({ ...r }));
  const int = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1000;
  switch (edit.op) {
    case 'move': {
      if (!int(edit.x) || !int(edit.y)) return 'bad position';
      const it = objects.find(o => o.id === edit.id) ?? rugs.find(r => r.id === edit.id);
      if (!it) return 'it\'s gone';
      if ('type' in it && FIXED_TYPES.has(it.type)) return `the ${objectName(it.type)} stays put`;
      it.x = edit.x; it.y = edit.y;
      break;
    }
    case 'rotate': {
      const it = objects.find(o => o.id === edit.id);
      if (!it) return 'it\'s gone';
      if (!SEAT_TYPES.has(it.type)) return `the ${objectName(it.type)} doesn't turn`;
      it.dir = TURN[it.dir ?? 'down']; it.turned = true;
      break;
    }
    case 'add': {
      const t = m.catalog[edit.type];
      if (!t || FIXED_TYPES.has(edit.type) || KEEP_TYPES.has(edit.type)) return 'can\'t add that';
      if (!int(edit.x) || !int(edit.y)) return 'bad position';
      objects.push({ ...structuredClone(t), id: newId(), x: edit.x, y: edit.y });
      break;
    }
    case 'remove': {
      const i = objects.findIndex(o => o.id === edit.id);
      if (i >= 0) { if (KEEP_TYPES.has(objects[i].type)) return `the office needs its ${objectName(objects[i].type)}`; objects.splice(i, 1); break; }
      const j = rugs.findIndex(r => r.id === edit.id);
      if (j < 0) return 'it\'s gone';
      rugs.splice(j, 1);
      break;
    }
    case 'rug_add': case 'rug': {
      const r = edit.op === 'rug' ? rugs.find(r => r.id === edit.id) : { id: newId(), color: 'green', x: edit.x, y: edit.y, w: 3, h: 2 };
      if (!r) return 'it\'s gone';
      if (edit.color !== undefined) r.color = edit.color;
      if (edit.pattern !== undefined) r.pattern = edit.pattern;
      if (edit.w !== undefined) r.w = edit.w;
      if (edit.h !== undefined) r.h = edit.h;
      if (!(RUG_COLORS as readonly string[]).includes(r.color) || (r.pattern !== undefined && !(RUG_PATTERNS as readonly string[]).includes(r.pattern))) return 'no such rug';
      if (!int(r.x) || !int(r.y) || !int(r.w) || !int(r.h) || r.w < RUG_MIN || r.h < RUG_MIN || r.w > RUG_MAX || r.h > RUG_MAX) return 'bad rug size';
      if (edit.op === 'rug_add') rugs.push(r);
      break;
    }
    default: return 'unknown edit';
  }
  return { objects, rugs };
}

/** The map as it would be with this layout: a copy, so a bad edit never touches the real one. */
export function withLayout(m: TileMap, l: Layout): TileMap {
  const copy: TileMap = { ...m, layers: { ...m.layers }, rooms: m.rooms.map(r => ({ ...r })) };
  applyLayout(copy, structuredClone(l));
  return copy;
}

/** Behind the instrument first; preserve besideObject order within each group. */
export function playSpots(m: TileMap, o: MapObject): Spot[] {
  const spots = besideObject(m, o);
  return [...spots.filter(s => s.dir === 'down'), ...spots.filter(s => s.dir !== 'down')];
}

/** Replace the old east wing once, including its one-of-a-kind fixtures an admin moved out of it. The saved ids come from
 *  an older build, so nothing outside the wing is matched by id: the rest out there is the admin's and stays. */
export function migrateEastWing(saved: Layout, base: Layout): Layout {
  if (saved.objects.some(o => o.type === 'arcade')) return saved;
  const touches = (o: { x: number; y: number; w: number; h: number }) => o.x < 64 && o.x + o.w > 54 && o.y < 23 && o.y + o.h > 3;
  const objects = base.objects.filter(touches), rugs = base.rugs.filter(touches);
  const fixtures = new Set(objects.filter(o => KEEP_TYPES.has(o.type)).map(o => o.type));
  return uniqueIds({
    objects: [...saved.objects.filter(o => !touches(o) && !fixtures.has(o.type)), ...structuredClone(objects)],
    rugs: [...saved.rugs.filter(o => !touches(o)), ...structuredClone(rugs)],
  }, base);
}

/** The layout with every id used once, objects and rugs together (edit mode finds either by id). Generated ids are
 *  positional, so a layout saved by an older build can share one with an object this build brings in: the one that is
 *  the generated object (same type, then same spot) keeps the id, the other gets a fresh one (o57 → o57-2). */
export function uniqueIds(l: Layout, base: Layout): Layout {
  const out = { objects: l.objects.map(o => ({ ...o })), rugs: l.rugs.map(r => ({ ...r })) };
  const all: (MapObject | Rug)[] = [...out.objects, ...out.rugs], used = new Set(all.map(o => o.id));
  const generated = new Map<string, MapObject | Rug>([...base.objects, ...base.rugs].map(o => [o.id, o]));
  const kind = (o: MapObject | Rug) => ('type' in o ? o.type : 'rug');
  const rank = (o: MapObject | Rug) => { const g = generated.get(o.id); return !g || kind(g) !== kind(o) ? 0 : g.x === o.x && g.y === o.y ? 2 : 1; };
  const keeper = new Map<string, MapObject | Rug>();
  for (const o of all) { const k = keeper.get(o.id); if (!k || rank(o) > rank(k)) keeper.set(o.id, o); }
  for (const o of all) if (keeper.get(o.id) !== o) {
    let n = 2; while (used.has(`${o.id}-${n}`)) n++;
    used.add(o.id = `${o.id}-${n}`);
  }
  return out;
}

/** A layout saved before the beach gets the generated wing furniture. The caller gates this by state version (so an
 *  emptied wing stays empty); a layout that already has furniture in the wing is left as it is. */
export function migrateBeach(saved: Layout, base: Layout, m: TileMap): Layout {
  const wing = m.rooms.filter(r => r.id === 'beach' || r.id === 'mountains');
  const inWing = (o: MapObject) => wing.some(r => inRect(r.rect, o.x, o.y));
  if (saved.objects.some(inWing)) return saved;
  return uniqueIds({ objects: [...saved.objects, ...structuredClone(base.objects.filter(inWing))], rugs: saved.rugs }, base);
}
