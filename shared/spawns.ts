// Daily spawns (engine item 4): a few items a day appear on free floor tiles around the office, seeded by the office day,
// so every restart and every client agrees. A new spawnable is one line in SPAWN_ITEMS (plus its ItemDef).
import type { Tile } from './map';

export const SPAWN_ITEMS = ['snowball', 'train', 'remote_car', 'sewing_kit'] as const;
export const SPAWNS_PER_DAY = 4;
export const SPAWN_BY = 'spawn'; // the `by` of an uncollected spawn on the props layer

/** A small deterministic generator (mulberry32) seeded from any string. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export interface Spawn { item: string; tile: Tile }
/** Which items appear where on this office day: `tiles` (free floor, in a stable order) is the only thing from the map. */
export function planSpawns(day: string, tiles: readonly Tile[], count = SPAWNS_PER_DAY): Spawn[] {
  const rng = seeded(`spawns:${day}`), pool = [...tiles], out: Spawn[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const item = SPAWN_ITEMS[Math.floor(rng() * SPAWN_ITEMS.length)];
    const [tile] = pool.splice(Math.floor(rng() * pool.length), 1);
    out.push({ item, tile: { x: tile.x, y: tile.y } });
  }
  return out;
}
