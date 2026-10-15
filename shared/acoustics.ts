import { hallDistance, roomAt, type Room, type Tile, type TileMap } from './map';
import { ZONE_IN_TILES } from './protocol';

export const SOUND_REF_TILES = 3;   // full volume this close
export const SOUND_ROLLOFF = .6;     // inverse-distance rolloff past REF (1 = physical; lower = gentler)
export const SOUND_MAX_TILES = 18;   // silent from here
export const ROOM_FILL = .4;         // in the source's own room you never drop below this: the room's reflections fill it
const OCCLUDED_GAIN = .6;
export const DOOR_SPREAD = 4;        // in another room, sound comes out of the doorway and dies out this many steps past it
export const PORTAL_LOSS = .35;      // each further doorway on the way costs this much
/** How much of a doorway's sound reaches you `k` steps past it (0 = standing in it). */
export const doorSpread = (k: number) => k <= 0 ? 1 : Math.max(0, 1 - k / (DOOR_SPREAD + 1));
/** Gain for a path distance through doors: gentle inverse law, faded to silence over the last 30% of the range. */
export const distanceGain = (d: number) => d === Infinity ? 0
  : 1 / (1 + SOUND_ROLLOFF * Math.max(0, d - SOUND_REF_TILES) / SOUND_REF_TILES)
    * (d <= .7 * SOUND_MAX_TILES ? 1 : Math.max(0, (SOUND_MAX_TILES - d) / (.3 * SOUND_MAX_TILES)));
const NEIGH = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function field(m: TileMap, listener: Tile): number[][] {
  const out = Array.from({ length: m.height }, () => Array(m.width).fill(Infinity));
  if (m.layers.walls[listener.y]?.[listener.x] !== 0) return out;
  const queue = [listener]; out[listener.y][listener.x] = 0;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i], d = out[p.y][p.x];
    if (d === SOUND_MAX_TILES) continue;
    for (const [dx, dy] of NEIGH) {
      const x = p.x + dx, y = p.y + dy;
      if (m.layers.walls[y]?.[x] === 0 && out[y][x] === Infinity) {
        out[y][x] = d + 1; queue.push({ x, y });
      }
    }
  }
  return out;
}
export interface SoundPose extends Tile { tile: Tile }
export interface SoundFlags { room?: Room; sourceMember?: boolean; knock?: boolean }
export function hallLevel(m: TileMap, room: Room, tile: Tile) {
  const d = hallDistance(m, room, tile.x, tile.y);
  return d === 0 ? 1 : Math.max(0, 1 - d / ZONE_IN_TILES);
}
const inside = (room: Room, t: Tile) => t.x >= room.rect.x && t.x < room.rect.x + room.rect.w && t.y >= room.rect.y && t.y < room.rect.y + room.rect.h;
function occluded(m: TileMap, me: SoundPose, source: SoundPose) {
  const steps = Math.ceil(Math.hypot(source.x - me.x, source.y - me.y) / .2);
  for (let i = 0; i <= steps; i++) {
    const f = steps ? i / steps : 0;
    const x = Math.floor(me.x + .5 + (source.x - me.x) * f), y = Math.floor(me.y + .5 + (source.y - me.y) * f);
    if (m.layers.walls[y]?.[x] !== 0) return true;
  }
  return false;
}
export function hallVoiceGain(m: TileMap, room: Room, me: SoundPose, source: SoundPose) {
  if (inside(room, me.tile) && inside(room, source.tile)) return 1;
  // Sample in one direction so floating-point rounding at wall corners stays symmetric.
  const [a, b] = me.x < source.x || (me.x === source.x && me.y <= source.y) ? [me, source] : [source, me];
  return hallLevel(m, room, me.tile) * hallLevel(m, room, source.tile) * (occluded(m, a, b) ? .8 : 1);
}
export function soundModel(m: TileMap, distances: number[][], me: SoundPose, source: SoundPose, flags: SoundFlags = {}) {
  const centre = { x: source.x + .5, y: source.y + .5 };
  const myRoom = roomAt(m, me.tile.x, me.tile.y), sourceRoom = roomAt(m, source.tile.x, source.tile.y);
  if (flags.knock) return { gain: 1, cutoff: 20000, pan: 0, send: 0, apparent: centre };
  if (flags.sourceMember && flags.room && myRoom?.id === flags.room.id && sourceRoom?.id === flags.room.id)
    return { gain: 1, cutoff: 20000, pan: clamp((source.x - me.x) / 14, -.25, .25), send: .12, apparent: centre };
  const d = distances[source.tile.y]?.[source.tile.x] ?? Infinity;
  const sameRoom = !!myRoom && myRoom.id === sourceRoom?.id;
  if (d === Infinity && !sameRoom) return { gain: 0, cutoff: 20000, pan: 0, send: 0, apparent: centre };
  const direct = Math.hypot(source.x - me.x, source.y - me.y);
  const g = sameRoom ? Math.max(ROOM_FILL, distanceGain(d)) : distanceGain(d);
  // beyond the field but in the same room: rooms have no inner walls, so it's a clear line
  if (d === Infinity) return { gain: g, cutoff: 20000, pan: clamp((centre.x - (me.x + .5)) / 10, -.35, .35), send: .12 * g, apparent: centre };
  const blocked = occluded(m, me, source);
  let apparent = centre, portal = 1;
  if (!sameRoom) {
    // rooms and portals: rebuild the shortest path (listener first) and see which doorways it goes through
    const route = [source.tile]; let p = source.tile;
    for (let n = d; n > 0; n--) {
      const next = NEIGH.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find(t => distances[t.y]?.[t.x] === n - 1)!;
      route.push(next); p = next;
    }
    route.reverse();
    const inDoor = route.map(t => !roomAt(m, t.x, t.y));
    const first = inDoor.indexOf(true), doors = inDoor.filter((v, i) => v && !inDoor[i - 1]).length;
    if (first >= 0) portal = doorSpread(first) * PORTAL_LOSS ** Math.max(0, doors - 1);
    const door = blocked ? route.slice(1).find((_, i) => inDoor[i + 1]) : undefined;
    if (door) apparent = { x: door.x + .5, y: door.y + .5 };
  }
  return { gain: g * portal * (blocked ? OCCLUDED_GAIN : 1), cutoff: blocked ? clamp(3000 - 200 * (d - direct), 900, 3000) : 20000,
    pan: clamp((apparent.x - (me.x + .5)) / 10, -.35, .35), send: (sameRoom ? .12 : .35) * g * portal, apparent };
}
export function reverbImpulse(room: Room | null, sampleRate: number): [Float32Array, Float32Array] {
  const material = room?.floor === 'tile_check' ? 1.3 : room?.floor === 'wood_dark' ? .7 : 1;
  const rt = room ? clamp(.3 + room.rect.w * room.rect.h / 120, .35, 1.2) * material : .6;
  const length = Math.floor(rt * sampleRate);
  let seed = 2166136261;
  for (const c of room?.id ?? 'hallway') seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
  const noise = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000 * 2 - 1; };
  const out: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  for (const channel of out) for (let i = 0; i < length; i++) channel[i] = noise() * Math.exp(-6.91 * i / sampleRate / rt);
  for (let i = 0; i < 6; i++) {
    const at = Math.floor((.007 + i * (.060 - .007) / 5) * sampleRate);
    if (at < length) out[i % 2][at] += .5 - i * .3 / 5;
  }
  for (const channel of out) {
    let prev = 0;
    for (let i = 0; i < length; i++) { const a = .6 - .45 * i / Math.max(1, length - 1); prev += a * (channel[i] - prev); channel[i] = prev; }
  }
  return out;
}
