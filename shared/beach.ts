import { inRect, type TileMap } from './map';

/** Terrain drives poses for everyone, independently of vacation status. */
export function terrainAt(map: TileMap, x: number, y: number): 'sand' | 'shallow' | 'deep' | 'trail' | 'snow' | 'pier' | null {
  const name = map.tiles[map.layers.floor[y]?.[x]] ?? '';
  if (/^sand_(?:wet_)?[0-2]$/.test(name)) return 'sand';
  if (/^water_shallow_[0-2]$/.test(name)) return 'shallow';
  if (/^water_deep_[0-2]$/.test(name)) return 'deep';
  if (/^trail_[0-1]$/.test(name)) return 'trail';
  if (/^snow_[0-1]$/.test(name)) return 'snow';
  return name === 'pier' ? 'pier' : null;
}

export const inWing = (map: TileMap, x: number, y: number) =>
  map.rooms.some(r => (r.id === 'beach' || r.id === 'mountains') && inRect(r.rect, x, y));
