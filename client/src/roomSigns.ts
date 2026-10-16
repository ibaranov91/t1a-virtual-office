import { roomAt, type Rect, type TileMap } from '../../shared/map';
import type { Frame } from './assets';

const W = 30, H = 19;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
/** Pixel bounds: signs follow room rules and find a clear mount in the current furniture layout. */
export function voiceSignPositions(map: TileMap, frames: Record<string, Frame>): (Rect & { roomId: string })[] {
  const ts = map.tileSize, signs: (Rect & { roomId: string })[] = [];
  const objects = map.objects.flatMap(o => {
    const f = frames[o.type];
    if (!f) return [];
    return [{ x: o.x * ts + (o.w * ts - f.w) / 2, y: o.wall ? o.y * ts : (o.y + o.h) * ts - f.h, w: f.w, h: f.h }];
  });
  const rugs = map.rugs.map(r => ({ x: r.x * ts, y: r.y * ts, w: r.w * ts, h: r.h * ts }));
  for (const room of map.rooms) {
    if (room.rules.voice !== 'open') continue;
    const { x, y, w, h } = room.rect, candidates: Rect[] = [], doors: Rect[] = [];
    const door = (ix: number, iy: number, ox: number, oy: number) => {
      if (map.layers.walkable[iy]?.[ix] && map.layers.walkable[oy]?.[ox]) doors.push({ x: ox * ts, y: oy * ts, w: ts, h: ts });
    };
    for (let tx = x; tx < x + w; tx++) { door(tx, y, tx, y - 1); door(tx, y + h - 1, tx, y + h); }
    for (let ty = y; ty < y + h; ty++) { door(x, ty, x - 1, ty); door(x + w - 1, ty, x + w, ty); }
    const add = (px: number, py: number) => candidates.push({ x: px, y: py, w: W, h: H });
    // Try the wall strips above and below the room, nearest its centre first.
    const xs: number[] = [];
    for (let px = x * ts; px <= (x + w) * ts - W; px++) xs.push(px);
    xs.sort((a, b) => Math.abs(a + W / 2 - (x + w / 2) * ts) - Math.abs(b + W / 2 - (x + w / 2) * ts));
    for (const py of [y * ts - H, (y + h) * ts]) for (const px of xs) add(px, py);
    for (let py = y * ts; py <= (y + h) * ts - H; py += 4) { add(x * ts - W, py); add((x + w) * ts, py); }
    // Match the renderer's wall layer; outdoor rooms have no majority wall row above them.
    const indoor = (map.layers.walls[y - 1]?.slice(x, x + w).filter(Boolean).length ?? 0) > w / 2;
    if (!indoor) {
      const floorXs: number[] = [];
      for (let px = x * ts; px <= (x + w) * ts - W; px += 4) floorXs.push(px);
      floorXs.sort((a, b) => Math.abs(a + W / 2 - (x + w / 2) * ts) - Math.abs(b + W / 2 - (x + w / 2) * ts));
      for (let py = y * ts; py <= (y + h) * ts - H; py += 4) for (const px of floorXs) add(px, py);
    }
    const office = map.office;
    const belongsHere = (c: Rect) => {
      const owner = roomAt(map, Math.floor((c.x + W / 2) / ts), Math.floor((c.y + H / 2) / ts));
      return !owner || owner.id === room.id;
    };
    const withinRoomBounds = (c: Rect) => belongsHere(c) && c.x >= office.x * ts && c.y >= office.y * ts
      && c.x + W <= (office.x + office.w) * ts && c.y + H <= (office.y + office.h) * ts;
    const padded = (c: Rect): Rect => ({ x: c.x - 1, y: c.y - 1, w: c.w + 2, h: c.h + 2 });
    // Rugs are floor: a wall sign may sit right at a rug's edge, only sprites, doors and signs need the 1 px gap.
    const clear = candidates.find(c => withinRoomBounds(c) && !rugs.some(r => overlaps(c, r))
      && ![...doors, ...objects, ...signs].some(o => overlaps(padded(c), o)));
    // A fully furnished indoor room still mounts on its top wall, with the least sprite overlap.
    const overlapArea = (c: Rect) => objects.reduce((area, o) => area
      + Math.max(0, Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x))
      * Math.max(0, Math.min(c.y + c.h, o.y + o.h) - Math.max(c.y, o.y)), 0);
    const fallback = indoor
      ? candidates.filter(c => c.y === y * ts - H).sort((a, b) => overlapArea(a) - overlapArea(b))[0]
      : { x: x * ts, y: y * ts, w: W, h: H };
    signs.push({ ...(clear ?? fallback), roomId: room.id });
  }
  return signs;
}
