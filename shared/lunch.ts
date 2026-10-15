// The dining terrace: take food from the cart, sit at a picnic table, eat for a while, leave a plate for the cleaner.
import { seatAt, type Dir, type MapObject, type Tile, type TileMap } from './map';

export const LUNCH_MS = 10 * 60_000;
export const FOOD_ITEMS = ['sandwich', 'ramen', 'salad', 'pizza'];
export const PICNIC_TABLE = 'table_picnic';
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
  const table = m.objects.find(o => o.type === PICNIC_TABLE && front.x >= o.x && front.x < o.x + o.w && front.y >= o.y && front.y < o.y + o.h);
  return table ? { seat, table, front } : null;
}
