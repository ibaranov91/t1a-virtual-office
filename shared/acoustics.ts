import { roomAt, type Room, type Tile, type TileMap } from './map';

export const SOUND_REF_TILES = 3;   // full volume this close
export const SOUND_ROLLOFF = .6;     // inverse-distance rolloff past REF (1 = physical; lower = gentler)
export const SOUND_MAX_TILES = 18;   // silent from here
export const ROOM_FILL = .4;         // in the source's own room you never drop below this: the room's reflections fill it
/** Gain for a path distance: gentle inverse law, faded to silence over the last 30% of the range. */
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
export function hallVoiceGain(m: TileMap, room: Room, me: SoundPose, source: SoundPose) {
  return roomAt(m, me.tile.x, me.tile.y)?.id === room.id && roomAt(m, source.tile.x, source.tile.y)?.id === room.id ? 1 : 0;
}
export function soundModel(m: TileMap, distances: number[][], me: SoundPose, source: SoundPose, flags: SoundFlags = {}) {
  const centre = { x: source.x + .5, y: source.y + .5 };
  const myRoom = roomAt(m, me.tile.x, me.tile.y), sourceRoom = roomAt(m, source.tile.x, source.tile.y);
  if (flags.knock) return { gain: 1, cutoff: 20000, pan: 0, send: 0, apparent: centre };
  if (!myRoom || myRoom.id !== sourceRoom?.id) return { gain: 0, cutoff: 20000, pan: 0, send: 0, apparent: centre };
  if (flags.sourceMember && flags.room?.id === myRoom.id)
    return { gain: 1, cutoff: 20000, pan: clamp((source.x - me.x) / 14, -.25, .25), send: .05, apparent: centre };
  const d = distances[source.tile.y]?.[source.tile.x] ?? Infinity;
  const gain = Math.max(ROOM_FILL, distanceGain(d));
  return { gain, cutoff: 20000, pan: clamp((source.x - me.x) / 10, -.35, .35), send: .05 * gain, apparent: centre };
}
export function reverbImpulse(room: Room, sampleRate: number): [Float32Array, Float32Array] {
  const material = room.floor === 'tile_check' ? 1.15 : room.floor === 'wood_dark' ? .8 : 1;
  const rt = clamp(.2 + room.rect.w * room.rect.h / 200, .25, .7) * material;
  const length = Math.floor(rt * sampleRate);
  let seed = 2166136261;
  for (const c of room.id) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
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
