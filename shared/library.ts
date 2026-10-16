// The Library: take a book from its shelf, sit at a reading table (or one of the reading desks) and read.
import { inRect, roomAt, seatAt, uniqueIds, type Dir, type Layout, type MapObject, type Tile, type TileMap } from './map';

export const LIBRARY_ROOM = 'library';
export const READING_FURNITURE = new Set(['reading_table', 'reading_desk']);

const STEP: Record<Dir, Tile> = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
/** A chair in the Library facing a reading table or desk: the table it faces. */
export function readingSeat(m: TileMap, t: Tile): { seat: Tile & { dir: Dir }; table: MapObject } | null {
  const seat = seatAt(m, t.x, t.y);
  if (seat?.type !== 'chair' || roomAt(m, t.x, t.y)?.id !== LIBRARY_ROOM) return null;
  const front = { x: t.x + STEP[seat.dir].x, y: t.y + STEP[seat.dir].y };
  const table = m.objects.find(o => READING_FURNITURE.has(o.type) && inRect(o, front.x, front.y));
  return table ? { seat, table } : null;
}
/** Every reading seat, in map order. */
export const readingSeats = (m: TileMap): Tile[] => m.objects.filter(o => o.type === 'chair' && readingSeat(m, o)).map(o => ({ x: o.x, y: o.y }));

/** A layout saved before the Library was built: whatever stood on its patch goes, the shelf's role moves from wherever
 *  it was to the Library's tall shelf, and the Library comes in as generated (the reading desks with it). */
export function migrateLibrary(saved: Layout, base: Layout, m: TileMap): Layout {
  if (saved.objects.some(o => o.type === 'reading_table')) return saved;
  const room = m.rooms.find(r => r.id === LIBRARY_ROOM);
  if (!room) return saved;
  const r = room.rect, touches = (o: { x: number; y: number; w: number; h: number }) => o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y;
  const objects = saved.objects.filter(o => !touches(o) && o.type !== 'reading_desk').map(o => {
    if (o.use?.kind !== 'library') return o;
    const { use: _use, ...plain } = o; return plain;
  });
  return uniqueIds({
    objects: [...objects, ...structuredClone(base.objects.filter(o => touches(o) && !o.wall))],
    rugs: [...saved.rugs.filter(o => !touches(o)), ...structuredClone(base.rugs.filter(touches))],
  }, base);
}
