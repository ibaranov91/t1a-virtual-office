// Where a cup or plate stands on a piece of furniture. Pure, so tests can check it against the art (tableTops.test.ts).

/** For each furniture type you can put a cup on (CUP_TABLES): the rows of its sprite, counted from the sprite's top,
 *  between the back and the front edge of the free tabletop. A desk's starts below the monitor's foot. */
export const TABLE_TOPS: Record<string, [back: number, front: number]> = {
  desk: [9, 14], table_long: [9, 31], table_big: [9, 30], table_round: [4, 13], table_picnic: [6, 14], counter: [2, 8],
};
/** Cup and plate sprites are 6 px tall, drawn 5 (cup) or 4 (plate) px in from the tile's left. */
export const ITEM_H = 6;

/** World y of the top of a cup or plate on this tile of this table, its frame `frameH` px tall (drawn bottom-aligned
 *  on the table's last row). Each tile row's spot sits 11 px down that row, pulled inside the tabletop. */
export function itemTop(table: { type: string; y: number; h: number }, tileY: number, frameH: number, ts = 16) {
  const [back, front] = TABLE_TOPS[table.type] ?? [0, frameH - 1];
  const spriteTop = (table.y + table.h) * ts - frameH;
  const bottom = Math.min(front, Math.max(back + ITEM_H - 1, (tileY - table.y) * ts + 11));
  return spriteTop + bottom - (ITEM_H - 1);
}
