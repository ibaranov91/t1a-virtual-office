import { roomAt, type Room, type Tile, type TileMap } from './map';

export const SOUND_REF_TILES = 3;   // full volume this close
export const SOUND_ROLLOFF = .6;     // inverse-distance rolloff past REF (1 = physical; lower = gentler)
export const SOUND_MAX_TILES = 18;   // silent from here
export const ROOM_FILL = .4;         // in the source's own room you never drop below this: the room's reflections fill it
/** Gain for a distance in tiles: gentle inverse law, faded to silence over the last 30% of the range. */
export const distanceGain = (d: number) => 1 / (1 + SOUND_ROLLOFF * Math.max(0, d - SOUND_REF_TILES) / SOUND_REF_TILES)
    * (d <= .7 * SOUND_MAX_TILES ? 1 : Math.max(0, (SOUND_MAX_TILES - d) / (.3 * SOUND_MAX_TILES)));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export interface SoundPose extends Tile { tile: Tile }
export interface SoundFlags { room?: Room; knock?: boolean }
export function soundModel(m: TileMap, me: SoundPose, source: SoundPose, flags: SoundFlags = {}) {
  const myRoom = roomAt(m, me.tile.x, me.tile.y), sourceRoom = roomAt(m, source.tile.x, source.tile.y);
  if (flags.knock) return { gain: 1, pan: 0, send: 0 };
  if (!myRoom || myRoom.id !== sourceRoom?.id) return { gain: 0, pan: 0, send: 0 };
  if (flags.room) return flags.room.id === myRoom.id
    ? { gain: 1, pan: clamp((source.x - me.x) / 14, -.25, .25), send: .05 }
    : { gain: 0, pan: 0, send: 0 };
  const d = Math.abs(source.tile.x - me.tile.x) + Math.abs(source.tile.y - me.tile.y);
  const gain = Math.max(ROOM_FILL, distanceGain(d));
  return { gain, pan: clamp((source.x - me.x) / 10, -.35, .35), send: .05 * gain };
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
