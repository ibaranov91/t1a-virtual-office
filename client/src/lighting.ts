// Lighting pass: the dark that night (and bad weather) lays over the floor, as one cached offscreen map.
// Lights come from map data (lamps and lit objects); the map is rebuilt only when the hour bucket, the weather, a light
// switch or the layout changes, never per frame. The engine just blits the part of it that is in view.
import { inRect, roomAt, type MapObject, type Rect, type TileMap } from '../../shared/map';
import { isOutdoor, OUTDOOR_ROOMS, type Weather } from '../../shared/weather';

/** Lightmap pixels per tile: 4 keeps the room edges soft without a big canvas (85×65 tiles → 340×260 px). */
export const LM = 4;

/** Objects that give light besides `light: true` ones (lamps, reading-table lamps), by how much a room counts them. */
export const LIT_TYPES: Readonly<Record<string, number>> = { floor_lamp: 1, arcade: 0.6, retro_tobu: 0.6, retro_lobster: 0.6, jukebox: 0.5, lofi_tv: 0.5, neon_sign: 1, dj_booth: 1.5, server_rack: 0.2, terminal: 0.3, coffee_machine: 0.2 };
/** How many lights an object counts as (0 when it is a switch that is off). */
export function lightWeight(o: MapObject, isOn: (o: MapObject) => boolean = () => true): number {
  const w = o.light ? 1 : LIT_TYPES[o.type] ?? 0;
  return w && isOn(o) ? w : 0;
}
/** Lights per room id (rooms without any are absent). Pure: tested. */
export function lightsByRoom(map: TileMap, isOn: (o: MapObject) => boolean = () => true): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of map.objects) {
    const w = lightWeight(o, isOn); if (!w) continue;
    const room = roomAt(map, o.x, o.y); if (room) out.set(room.id, (out.get(room.id) ?? 0) + w);
  }
  return out;
}

/** Evening and night as a colour and how deep it is (0 day … 1 the dead of night), by the viewer's local hour. */
const KEYS: [number, number, number, number, number][] = [ // [hour, r, g, b, night]
  [0, 40, 50, 110, 1], [5.5, 40, 50, 110, 1], [7, 255, 190, 170, 0.36], [9, 255, 255, 255, 0],
  [16.5, 255, 255, 255, 0], [18.5, 255, 170, 90, 0.44], [20.5, 60, 60, 130, 0.84], [24, 40, 50, 110, 1],
];
export function nightAt(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  let i = 0; while (i < KEYS.length - 2 && h >= KEYS[i + 1][0]) i++;
  const [h0, ...a] = KEYS[i], [h1, ...b] = KEYS[i + 1], f = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  const m = a.map((v, j) => v + (b[j] - v) * f);
  return { r: m[0], g: m[1], b: m[2], night: m[3] };
}
/** Bad weather darkens the day a little (rain more than fog). */
export const GLOOM: Record<Weather, number> = { clear: 0, rain: 0.2, fog: 0.12 };
export const gloomy = (night: number, weather: Weather) => Math.min(1, night + GLOOM[weather] * (1 - night * 0.5));

/** Darkness (alpha 0–1) of open sky: darker than a lit room, lighter than a room nobody lit. */
export const outdoorDark = (night: number) => 0.62 * night;
/** Darkness of a room with `lights` lights: none is very dark, each light eases it, and a lit room is never bright. */
export const indoorDark = (night: number, lights: number) => night * (0.3 + 0.5 * Math.exp(-0.75 * lights));

/** Darkness per tile (row-major, `map.width × map.height`). Wall tiles take the average of the rooms around them. */
export function tileDarkness(map: TileMap, night: number, lights: Map<string, number>): Float32Array {
  const { width: W, height: H } = map, out = new Float32Array(W * H).fill(-1);
  const roomDark = new Map(map.rooms.map(r => [r.id, indoorDark(night, lights.get(r.id) ?? 0)]));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const room = roomAt(map, x, y);
    if (room) out[y * W + x] = OUTDOOR_ROOMS.has(room.id) ? outdoorDark(night) : roomDark.get(room.id)!;
    else if (isOutdoor(map, x, y)) out[y * W + x] = outdoorDark(night);
  }
  for (let pass = 0; pass < 4; pass++) { // walls and the black rim: whatever the neighbours already know
    const next = out.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (out[y * W + x] >= 0) continue;
      let sum = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const v = x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H ? out[(y + dy) * W + x + dx] : -1; if (v >= 0) { sum += v; n++; } }
      if (n) next[y * W + x] = sum / n;
    }
    out.set(next);
  }
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = indoorDark(night, 0);
  return out;
}

/** The light's own reach in tiles, and how much of the dark it clears at its centre. */
const POOL_R = 3.4, POOL_K = 0.42;

export interface LightmapKey { hourBucket: number; weather: Weather; lights: string; layout: number }
export const lightmapKey = (k: LightmapKey) => `${k.hourBucket}|${k.weather}|${k.lights}|${k.layout}`;
/** Minutes are enough resolution for the sky: the dusk takes two hours. */
export const hourBucket = (hour: number) => Math.floor(hour * 30); // two-minute steps

/**
 * Paint the lightmap: every tile gets its darkness, then each light clears a soft pool of it inside its own room.
 * `canvas` is reused (resized once). Returns the darkness colour used, for tests and the engine's glows.
 */
export function paintLightmap(canvas: HTMLCanvasElement, map: TileMap, hour: number, weather: Weather, isOn: (o: MapObject) => boolean) {
  const W = map.width, H = map.height, { r, g, b, night: raw } = nightAt(hour), night = gloomy(raw, weather);
  canvas.width = W * LM; canvas.height = H * LM;
  const ctx = canvas.getContext('2d')!, dark = tileDarkness(map, night, lightsByRoom(map, isOn));
  // dark colour: the sky's tint pulled down; deep navy at night
  const k = 0.3, c = [r * k, g * k, b * k].map((v, i) => Math.round(v + ([14, 18, 42][i] - v) * night));
  const img = ctx.createImageData(canvas.width, canvas.height), d = img.data;
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const a = Math.round(dark[ty * W + tx] * 255);
    for (let py = 0; py < LM; py++) for (let px = 0; px < LM; px++) {
      const i = ((ty * LM + py) * canvas.width + tx * LM + px) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  for (const o of map.objects) {
    const w = lightWeight(o, isOn), room = w ? roomAt(map, o.x, o.y) : undefined;
    if (!room || night < 0.05) continue;
    const cx = (o.x + o.w / 2) * LM, cy = (o.y + o.h / 2) * LM, rad = POOL_R * LM * Math.min(1.4, 0.8 + w * 0.3);
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, `rgba(0,0,0,${Math.min(0.55, POOL_K * w)})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); const rc: Rect = room.rect;
    ctx.beginPath(); ctx.rect((rc.x - 0.5) * LM, (rc.y - 0.5) * LM, (rc.w + 1) * LM, (rc.h + 1) * LM); ctx.clip(); // light stays in its room
    ctx.fillStyle = gr; ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2); ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  return { night, raw, color: c };
}

/** Is `t` inside `r`? (re-exported for the roof) */
export const inside = (r: Rect, x: number, y: number) => inRect(r, x, y);
