import { roomAt, type Rect, type TileMap } from '../../shared/map';
import type { Frame } from './assets';

const W = 64, H = 25;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
/** Pixel bounds: signs follow room rules and find a clear mount in the current furniture layout. */
export function voiceSignPositions(map: TileMap, frames: Record<string, Frame>): (Rect & { roomId: string })[] {
  const ts = map.tileSize, signs: (Rect & { roomId: string })[] = [];
  const preferred: Record<string, [number, number]> = { coffee: [112, 128], music: [0, 128], arcade: [0, 160], bookclub: [32, 110] };
  const objects = map.objects.flatMap(o => {
    const f = frames[o.type];
    if (!f) return [];
    return [{ x: o.x * ts + (o.w * ts - f.w) / 2, y: o.wall ? o.y * ts : (o.y + o.h) * ts - f.h, w: f.w, h: f.h }];
  });
  for (const room of map.rooms) {
    if (room.rules.voice !== 'open') continue;
    const { x, y, w, h } = room.rect, candidates: Rect[] = [], doors: Rect[] = [];
    const door = (ix: number, iy: number, ox: number, oy: number) => {
      if (map.layers.walkable[iy]?.[ix] && map.layers.walkable[oy]?.[ox]) doors.push({ x: ox * ts, y: oy * ts, w: ts, h: ts });
    };
    for (let tx = x; tx < x + w; tx++) { door(tx, y, tx, y - 1); door(tx, y + h - 1, tx, y + h); }
    for (let ty = y; ty < y + h; ty++) { door(x, ty, x - 1, ty); door(x + w - 1, ty, x + w, ty); }
    const add = (px: number, py: number) => candidates.push({ x: px, y: py, w: W, h: H });
    const mount = preferred[room.id];
    if (mount) add(x * ts + mount[0], y * ts + mount[1]);
    // Try the wall strips above and below the room, nearest its centre first.
    const xs: number[] = [];
    for (let px = x * ts; px <= (x + w) * ts - W; px += 4) xs.push(px);
    xs.sort((a, b) => Math.abs(a + W / 2 - (x + w / 2) * ts) - Math.abs(b + W / 2 - (x + w / 2) * ts));
    for (const py of [y * ts - H, (y + h) * ts]) for (const px of xs) add(px, py);
    for (let py = y * ts; py <= (y + h) * ts - H; py += 4) { add(x * ts - W, py); add((x + w) * ts, py); }
    // Outdoor rooms have no wall: use a clear patch along their edge, then inside.
    for (let py = y * ts; py <= (y + h) * ts - H; py += 4) for (const px of xs) add(px, py);
    const office = map.office;
    const belongsHere = (c: Rect) => {
      const owner = roomAt(map, Math.floor((c.x + W / 2) / ts), Math.floor((c.y + H / 2) / ts));
      return !owner || owner.id === room.id;
    };
    const clear = candidates.find(c => belongsHere(c) && c.x >= office.x * ts && c.y >= office.y * ts
      && c.x + W <= (office.x + office.w) * ts && c.y + H <= (office.y + office.h) * ts
      && !doors.some(d => overlaps(c, d)) && !objects.some(o => overlaps(c, o)) && !signs.some(s => overlaps(c, s)));
    // A completely furnished room still needs its mode visible; keep the sign at its entrance edge.
    signs.push({ ...(clear ?? { x: x * ts, y: y * ts, w: W, h: H }), roomId: room.id });
  }
  return signs;
}
