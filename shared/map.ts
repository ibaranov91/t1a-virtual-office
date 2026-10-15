import { ZONE_OUT_TILES, type LayoutEdit } from './protocol';

// Shared floor logic: used by the server AND every client, so paths are identical everywhere.

export type Dir = 'down' | 'left' | 'right' | 'up';
export interface Tile { x: number; y: number }
export interface Spot extends Tile { dir: Dir }
export type KnockRule = 'allow' | 'disabled' | 'later';
export interface Room {
  id: string; name: string; type: string;
  rect: { x: number; y: number; w: number; h: number };
  capacity: number; floor: string; rug: string;
  stand: Spot[];  // standing spots (no furniture); `spots` adds every seat, so it follows the furniture
  spots: Spot[];
  homeDesks?: boolean; // seats here can be claimed as someone's home desk
  plantSlots?: Tile[];  // where plants of people without a home desk stand (the Orangery's shelves)
  rules: { voice?: 'open'; knock: KnockRule; label?: string; occupantLabel?: string };
  meeting: { provider: 'meet' | 'teams'; url: string };
}
/** Something you can hold for a while, taken from an object (a coffee from the machine). */
export interface UseItem { id: string; label: string; icon: string }
/** What clicking an object offers: take something from it, flip it on/off, or look at your calendar on it. */
export type ObjectUse = { kind: 'take'; items: UseItem[] } | { kind: 'toggle'; label: string } | { kind: 'calendar'; label: string }
  | { kind: 'meetings'; label: string } // the board by the Meeting room: which calendar meetings are on
  | { kind: 'achievements'; label: string }; // the Lobby notice board: your plant and your badges
export interface MapObject {
  id: string; type: string; x: number; y: number; w: number; h: number;
  sound?: { clip: string; gain: number };
  wall?: boolean; walkable?: boolean; light?: boolean; steam?: boolean; dir?: Dir;
  use?: ObjectUse; on?: boolean; // on: starting state of a toggle
  sit?: boolean; // a sofa: blocks walking, but every tile is a seat facing `dir`, reached from the tile in front
}
/** A rug, drawn over the floor (9-slice). Never blocks. */
export interface Rug { id: string; color: string; x: number; y: number; w: number; h: number }
export const RUG_COLORS = ['green', 'blue', 'orange', 'red', 'teal'] as const;
/** What office admins can rearrange: the furniture and the rugs. Walls, floors and rooms stay as generated. */
export interface Layout { objects: MapObject[]; rugs: Rug[] }
/** A kind of object an admin can add: everything but its id and position. */
export type ObjectTemplate = Omit<MapObject, 'id' | 'x' | 'y'>;
export interface TileMap {
  version: number; width: number; height: number; tileSize: number;
  tiles: string[];
  layers: { floor: number[][]; walls: number[][]; walkable: number[][] };
  rooms: Room[]; objects: MapObject[]; rugs: Rug[]; spawn: Tile;
  exit: Tile; // where people walk to leave, and appear when they come back
  catalog: Record<string, ObjectTemplate>; // one of each kind of object, as generated
}

export const WALK_MS_PER_TILE = 250; // 4 tiles/s

const SEAT_TYPES = new Set(['chair', 'stool']);
/**
 * Per-tile lookups, built once per map: the map is read many times a frame (every sprite, every path), so
 * walkable/room/seat are flat typed arrays indexed by `y * width + x` instead of scans over rooms and objects.
 * `g`, `came` and `seen` are A*'s scratch space, reused across calls (`seen` holds a generation stamp, so
 * nothing is cleared between searches).
 */
const halls = new WeakMap<TileMap, Map<Room, number[][]>>(); // hallDistance's BFS results
interface MapIndex {
  walk: Uint8Array; room: Int8Array; seat: Int16Array; byId: Map<string, MapObject>;
  g: Int32Array; came: Int32Array; seen: Uint32Array; gen: number;
}
const indexes = new WeakMap<TileMap, MapIndex>();
/** Maps are read-only once in use; after editing one (tests), drop its index so the next lookup rebuilds it. */
export const reindexMap = (m: TileMap) => { indexes.delete(m); halls.delete(m); };
export function mapIndex(m: TileMap): MapIndex {
  let ix = indexes.get(m);
  if (ix) return ix;
  const n = m.width * m.height;
  const walk = new Uint8Array(n), room = new Int8Array(n).fill(-1), seat = new Int16Array(n).fill(-1);
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) walk[y * m.width + x] = m.layers.walkable[y][x] === 1 ? 1 : 0;
  m.rooms.forEach((r, i) => {
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) room[y * m.width + x] = i;
  });
  m.objects.forEach((o, i) => { // first match wins, like the old `find`
    if (SEAT_TYPES.has(o.type)) { const k = o.y * m.width + o.x; if (seat[k] < 0) seat[k] = i; }
    else if (o.sit) for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) { const k = y * m.width + x; if (seat[k] < 0) seat[k] = i; }
  });
  ix = { walk, room, seat, byId: new Map(m.objects.map(o => [o.id, o])), g: new Int32Array(n), came: new Int32Array(n), seen: new Uint32Array(n), gen: 0 };
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

export const objectById = (m: TileMap, id: string) => mapIndex(m).byId.get(id);

// Deterministic 4-neighbour A*. Returns tiles from `from` to `to` inclusive, or [] if unreachable.
const NEIGH: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export function findPath(m: TileMap, from: Tile, to: Tile): Tile[] {
  if (!isWalkable(m, to.x, to.y)) return [];
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const W = m.width, key = (x: number, y: number) => y * W + x;
  const ix = mapIndex(m), walk = ix.walk, gen = ++ix.gen;
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
      if (walk[nk] !== 1) continue;
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

export interface Move { from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir }

export const dirBetween = (a: Tile, b: Tile, fallback: Dir = 'down'): Dir =>
  b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : b.y < a.y ? 'up' : fallback;

/** Interpolated position along a path at time t. `x,y` are fractional tiles. */
export function sampleMove(path: Tile[], startedAt: number, t: number) {
  if (path.length === 0) return null;
  const elapsed = Math.max(0, t - startedAt);
  const seg = elapsed / WALK_MS_PER_TILE;
  const i = Math.floor(seg);
  if (i >= path.length - 1) {
    const last = path[path.length - 1];
    const prev = path[path.length - 2] ?? last;
    return { x: last.x, y: last.y, dir: dirBetween(prev, last), done: true, tile: last, next: last };
  }
  const a = path[i], b = path[i + 1], f = seg - i;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dir: dirBetween(a, b), done: false, tile: f < 0.5 ? a : b, next: b };
}

const STEP: Record<Dir, Tile> = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
/** Path to `to`. Sofa seats aren't walkable: you sit down onto one from the tile in front, and get up the same way. */
export function pathTo(m: TileMap, from: Tile, to: Tile): Tile[] {
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const front = (t: Tile) => {
    if (isWalkable(m, t.x, t.y)) return null;
    const s = seatAt(m, t.x, t.y);
    return s && { x: t.x + STEP[s.dir].x, y: t.y + STEP[s.dir].y };
  };
  const up = front(from), down = front(to);
  if (!isWalkable(m, to.x, to.y) && !down) return [];
  const mid = findPath(m, up ?? from, down ?? to);
  if (!mid.length) return [];
  return [...(up ? [{ ...from }] : []), ...mid, ...(down ? [{ ...to }] : [])];
}

export const pathDuration = (path: Tile[]) => Math.max(0, path.length - 1) * WALK_MS_PER_TILE;

/** Free walkable tiles touching an object's footprint, each with the direction that faces the object. */
export function besideObject(m: TileMap, o: MapObject): Spot[] {
  const out: Spot[] = [];
  for (let x = o.x; x < o.x + o.w; x++) { out.push({ x, y: o.y + o.h, dir: 'up' }); out.push({ x, y: o.y - 1, dir: 'down' }); }
  for (let y = o.y; y < o.y + o.h; y++) { out.push({ x: o.x - 1, y, dir: 'right' }); out.push({ x: o.x + o.w, y, dir: 'left' }); }
  return out.filter(t => isWalkable(m, t.x, t.y));
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
export function hallDistance(m: TileMap, room: Room, x: number, y: number): number {
  let rooms = halls.get(m);
  if (!rooms) halls.set(m, rooms = new Map());
  let distances = rooms.get(room);
  if (!distances) {
    distances = Array.from({ length: m.height }, () => Array(m.width).fill(Infinity));
    const queue: Tile[] = [];
    const { x, y, w, h } = room.rect;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (isWalkable(m, xx, yy) || seatAt(m, xx, yy)) { distances[yy][xx] = 0; queue.push({ x: xx, y: yy }); }
    }
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i], d = distances[p.y][p.x];
      if (d === ZONE_OUT_TILES) continue;
      for (const [dx, dy] of NEIGH) {
        const x = p.x + dx, y = p.y + dy;
        if ((isWalkable(m, x, y) || seatAt(m, x, y)) && distances[y]?.[x] === Infinity) {
          distances[y][x] = d + 1; queue.push({ x, y });
        }
      }
    }
    rooms.set(room, distances);
  }
  return distances[y]?.[x] ?? Infinity;
}

// ---------- layout: what the furniture decides ----------
const inRect = (o: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;
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
    if (o.sit) { if (r) for (let x = o.x; x < o.x + o.w; x++) r.spots.push({ x, y: o.y, dir: o.dir ?? 'down' }); continue; }
    if (o.type === 'plant_shelf') { if (r) for (let x = o.x; x < o.x + o.w; x++) (r.plantSlots ??= []).push({ x, y: o.y }); continue; }
    if (!SEAT_TYPES.has(o.type)) continue;
    // face the neighbouring furniture
    o.dir = !free(o.x, o.y - 1) && walls[o.y - 1]?.[o.x] === 0 ? 'up' : !free(o.x, o.y + 1) ? 'down' : !free(o.x + 1, o.y) ? 'right' : !free(o.x - 1, o.y) ? 'left' : 'down';
    if (r) r.spots.push({ x: o.x, y: o.y, dir: o.dir });
  }
  for (const r of m.rooms) for (const s of r.stand) if (free(s.x, s.y) && !r.spots.some(p => p.x === s.x && p.y === s.y)) r.spots.push(s);
  reindexMap(m);
}

/** Why this layout won't do, or null if it's fine: furniture on the floor and decor on the walls, nothing on top of
 *  anything else, and the way in, every doorway, every seat and everything you can use still reachable. */
export function layoutProblem(m: TileMap): string | null {
  const { walls, floor } = m.layers;
  const inside = (t: Tile) => t.x >= 0 && t.y >= 0 && t.x < m.width && t.y < m.height;
  const taken = new Map<string, string>();
  const claim = (key: string, what: string) => { const had = taken.get(key); taken.set(key, what); return had; };
  for (const o of m.objects) for (const t of footprint(o)) {
    if (!inside(t)) return `the ${objectName(o.type)} is off the map`;
    if (o.wall ? !walls[t.y][t.x] : walls[t.y][t.x]) return o.wall ? `the ${objectName(o.type)} goes on a wall` : `the ${objectName(o.type)} can't stand in a wall`;
    const had = claim(`${o.wall ? 'w' : 'f'}${t.x},${t.y}`, objectName(o.type));
    if (had) return `the ${objectName(o.type)} overlaps the ${had}`;
  }
  for (const r of m.rugs) for (const t of footprint(r)) {
    if (!inside(t) || walls[t.y][t.x]) return 'a rug has to lie on the floor';
    if (claim(`r${t.x},${t.y}`, 'rug')) return 'rugs can\'t overlap';
  }
  const reached = new Set([`${m.spawn.x},${m.spawn.y}`]), queue = [m.spawn];
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of NEIGH) {
    const x = queue[i].x + dx, y = queue[i].y + dy, key = `${x},${y}`;
    if (isWalkable(m, x, y) && !reached.has(key)) { reached.add(key); queue.push({ x, y }); }
  }
  const ok = (t: Tile) => reached.has(`${t.x},${t.y}`);
  if (!ok(m.exit)) return 'that blocks the way in';
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (m.tiles[floor[y][x]] === 'door_floor' && !walls[y][x] && !ok({ x, y })) return 'that blocks a doorway';
  }
  for (const r of m.rooms) for (const s of r.spots) {
    const sofa = m.objects.find(o => o.sit && inRect(o, s.x, s.y));
    const step = sofa ? STEP[sofa.dir ?? 'down'] : { x: 0, y: 0 };
    if (!ok({ x: s.x + step.x, y: s.y + step.y })) return `that cuts off a seat in ${r.name}`;
  }
  // you walk over to these to use them (the calendars and boards just open)
  for (const o of m.objects) if ((o.use?.kind === 'take' || o.use?.kind === 'toggle') && !besideObject(m, o).some(ok)) return `nobody could reach the ${objectName(o.type)}`;
  return null;
}

/** What to call an object type in the UI: "big table", not table_big. */
export const objectName = (type: string) => ({ table_long: 'long table', table_big: 'big table', table_round: 'round table', plant_shelf: 'plant shelf',
  painting_small: 'small painting', coffee_machine: 'coffee machine', meetings_board: 'meetings board', noticeboard: 'notice board', exit_door: 'exit door' } as Record<string, string>)[type] ?? type.replace(/_/g, ' ');

/** Types that are one of a kind (the way out, the coffee machine…): they can be moved but not removed. */
export const KEEP_TYPES = new Set(['exit_door', 'coffee_machine', 'fridge', 'radio', 'meetings_board', 'noticeboard']);
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
      if (edit.w !== undefined) r.w = edit.w;
      if (edit.h !== undefined) r.h = edit.h;
      if (!(RUG_COLORS as readonly string[]).includes(r.color)) return 'no such rug';
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
