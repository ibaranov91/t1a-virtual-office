// Shared floor logic: used by the server AND every client, so paths are identical everywhere.

export type Dir = 'down' | 'left' | 'right' | 'up';
export interface Tile { x: number; y: number }
export interface Spot extends Tile { dir: Dir }
export type KnockRule = 'allow' | 'disabled' | 'later';
export interface Room {
  id: string; name: string; type: string;
  rect: { x: number; y: number; w: number; h: number };
  capacity: number; floor: string; rug: string; spots: Spot[];
  rules: { knock: KnockRule; label?: string; occupantLabel?: string };
  meeting: { provider: 'meet' | 'teams'; url: string };
}
export interface MapObject {
  id: string; type: string; x: number; y: number; w: number; h: number;
  wall?: boolean; walkable?: boolean; light?: boolean; steam?: boolean;
}
export interface TileMap {
  version: number; width: number; height: number; tileSize: number;
  tiles: string[];
  layers: { floor: number[][]; walls: number[][]; walkable: number[][] };
  rooms: Room[]; objects: MapObject[]; spawn: Tile;
}

export const WALK_MS_PER_TILE = 250; // 4 tiles/s

export const isWalkable = (m: TileMap, x: number, y: number) =>
  x >= 0 && y >= 0 && x < m.width && y < m.height && m.layers.walkable[y][x] === 1;

export const roomAt = (m: TileMap, x: number, y: number): Room | undefined =>
  m.rooms.find(r => x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h);

// Deterministic 4-neighbour A*. Returns tiles from `from` to `to` inclusive, or [] if unreachable.
const NEIGH: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export function findPath(m: TileMap, from: Tile, to: Tile): Tile[] {
  if (!isWalkable(m, to.x, to.y)) return [];
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const W = m.width, key = (x: number, y: number) => y * W + x;
  const g = new Map<number, number>(), came = new Map<number, number>();
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
  g.set(start, 0); push([h(from.x, from.y), h(from.x, from.y), seq++, start]);
  while (heap.length) {
    const [, , , k] = pop();
    if (k === goal) break;
    const cx = k % W, cy = (k / W) | 0, cg = g.get(k)!;
    for (const [dx, dy] of NEIGH) {
      const nx = cx + dx, ny = cy + dy;
      if (!isWalkable(m, nx, ny)) continue;
      const nk = key(nx, ny), ng = cg + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng); came.set(nk, k);
        const hh = h(nx, ny); push([ng + hh, hh, seq++, nk]);
      }
    }
  }
  if (!came.has(goal)) return [];
  const out: Tile[] = [];
  for (let k: number | undefined = goal; k !== undefined; k = came.get(k)) {
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

export const pathDuration = (path: Tile[]) => Math.max(0, path.length - 1) * WALK_MS_PER_TILE;
