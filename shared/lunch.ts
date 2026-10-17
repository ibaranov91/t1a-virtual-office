// The dining terrace: take food from the cart, sit at a picnic table, eat for a while, leave a plate for the cleaner.
import { inRect, isWalkable, seatAt, type Dir, type MapObject, type Tile, type TileMap } from './map';

export const LUNCH_MS = 10 * 60_000;
export const FOOD_ITEMS = ['sandwich', 'ramen', 'salad', 'pizza', 'hot_noodles'];
export const PICNIC_TABLE = 'table_picnic';
/** Tables in the kitchen (the Coffee room) where food is eaten too: standing or on a stool, and no table voice (the room is open talk anyway). */
export const KITCHEN_TABLES = ['table_round', 'bar_table'];
/** Plates live in the cups list as `plate:<food>`, counted apart from cups so they don't crowd each other out. */
export const MAX_PLATES = 8;
export const PLATE_PREFIX = 'plate:';
export const isPlate = (item: string) => item.startsWith(PLATE_PREFIX);
export const plateFood = (item: string) => item.slice(PLATE_PREFIX.length);

/** Eating: the food in front of you for LUNCH_MS. open: you don't mind being knocked on. Public. */
export interface Eating { item: string; until: number; open: boolean }

const STEP: Record<Dir, Tile> = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
/** A chair at a picnic table: the table it faces and the table tile right in front of the sitter. */
export function picnicSeat(m: TileMap, t: Tile): { seat: Tile & { dir: Dir }; table: MapObject; front: Tile } | null {
  const seat = seatAt(m, t.x, t.y);
  if (seat?.type !== 'chair') return null;
  const front = { x: t.x + STEP[seat.dir].x, y: t.y + STEP[seat.dir].y };
  const table = m.objects.find(o => o.type === PICNIC_TABLE && inRect(o, front.x, front.y));
  return table ? { seat, table, front } : null;
}

/** A tile beside a kitchen table (a stool, or standing room): where you can eat food from your hands. No table voice there. */
export function kitchenSpot(m: TileMap, t: Tile): { seat: Tile & { dir: Dir }; table: MapObject; front: Tile } | null {
  if (m.rooms.find(r => inRect(r.rect, t.x, t.y))?.type !== 'coffee') return null;
  if (!isWalkable(m, t.x, t.y) && !seatAt(m, t.x, t.y)) return null;
  for (const dir of ['up', 'left', 'right', 'down'] as Dir[]) {
    const front = { x: t.x + STEP[dir].x, y: t.y + STEP[dir].y };
    const table = m.objects.find(o => KITCHEN_TABLES.includes(o.type) && inRect(o, front.x, front.y));
    if (table) return { seat: { ...t, dir }, table, front };
  }
  return null;
}
/** Where food gets eaten: a chair at a picnic table, or beside a kitchen table. */
export const eatSpot = (m: TileMap, t: Tile) => picnicSeat(m, t) ?? kitchenSpot(m, t);
