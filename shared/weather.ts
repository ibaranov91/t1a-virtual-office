// Weather: one state for the whole office (server-owned), scheduled by office time so everyone gets the same sky.
// Also where the "outdoors" rule lives, since rain, fog and the lightmap all ask it.
import { inRect, roomAt, type TileMap } from './map';
import { terrainAt } from './beach';
import { officeDay, officeMinutes } from './officeTime';

export type Weather = 'clear' | 'rain' | 'fog';
export const WEATHERS: readonly Weather[] = ['clear', 'rain', 'fog'];
export const isWeather = (w: unknown): w is Weather => typeof w === 'string' && (WEATHERS as readonly string[]).includes(w);
export const WEATHER_LABEL: Record<Weather, string> = { clear: 'Clear', rain: 'Rain', fog: 'Fog' };

/** The sky changes every two hours of office time. */
export const WEATHER_BLOCK_MIN = 120;
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); return (h ^ (h >>> 13)) >>> 0; };
/** Seeded by the office day and block: fog likes the early morning, rain comes at any hour, most blocks are clear. */
export function scheduledWeather(now = Date.now()): Weather {
  const block = Math.floor(officeMinutes(now) / WEATHER_BLOCK_MIN), r = (hash(`${officeDay(now)}#${block}`) % 1000) / 1000;
  const fog = block < 5 ? 0.2 : 0.04, rain = 0.2;
  return r < fog ? 'fog' : r < fog + rain ? 'rain' : 'clear';
}

/** Rooms that are open sky. */
export const OUTDOOR_ROOMS: ReadonlySet<string> = new Set(['garden', 'terrace', 'beach', 'mountains']);
/** Open sky over this tile: the outdoor rooms, loose terrain (sand, water, trail) and everything beyond the office. */
export function isOutdoor(map: TileMap, x: number, y: number): boolean {
  const room = roomAt(map, x, y);
  if (room) return OUTDOOR_ROOMS.has(room.id);
  return !inRect(map.office, x, y) || terrainAt(map, x, y) !== null;
}

/** Fog: tiles within FOG_CLEAR of you are clear, the fog thickens up to FOG_MAX_ALPHA at FOG_FULL, and people past FOG_HIDE
 *  (outdoors) are hidden. */
export const FOG_CLEAR = 4.5, FOG_FULL = 9, FOG_HIDE = 6.5, FOG_MAX_ALPHA = 0.88;
export const fogAlpha = (dist: number) => dist <= FOG_CLEAR ? 0 : Math.min(1, (dist - FOG_CLEAR) / (FOG_FULL - FOG_CLEAR)) * FOG_MAX_ALPHA;
/** Is `other` swallowed by fog for a viewer standing on `me`? The fog is outdoors: it counts when either of them is out in it. */
export function fogHides(map: TileMap, weather: Weather, me: { x: number; y: number }, other: { x: number; y: number }): boolean {
  if (weather !== 'fog' || Math.hypot(other.x - me.x, other.y - me.y) <= FOG_HIDE) return false;
  return isOutdoor(map, other.x, other.y) || isOutdoor(map, me.x, me.y);
}
