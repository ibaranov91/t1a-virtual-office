import { doorwayTiles, roomAt, type Room, type Tile, type TileMap } from '../../shared/map';

export interface RoomDoor {
  room: Room; tiles: Tile[]; x: number; y: number; w: number; h: number; horizontal: boolean;
  locked: boolean; // admins only: stays shut (red light) for everyone else
  glass?: boolean; // the 7/11's street door: the usual door, in glass
}
export function roomDoors(m: TileMap): RoomDoor[] {
  const rooms = new Set(m.objects.filter(o => o.sound).map(o => roomAt(m, o.x, o.y)?.id));
  return doorsOf(m, m.rooms.filter(r => r.rules.voice === 'open' || rooms.has(r.id)));
}
/** The 7/11's street door (from the Arcade): a glass door. */
export const glassDoors = (m: TileMap): RoomDoor[] =>
  doorsOf(m, m.rooms.filter(r => r.id === 'shop')).filter(d => !d.horizontal && d.x === 64).map(d => ({ ...d, glass: true }));
/** Doors of rooms only admins may enter: drawn shut (red light) for everyone else. */
export const lockedDoors = (m: TileMap) => doorsOf(m, m.rooms.filter(r => r.rules.access));
function doorsOf(m: TileMap, rooms: Room[]): RoomDoor[] {
  return rooms.flatMap(room => doorwayTiles(m, room).map(tiles => {
    const x = Math.min(...tiles.map(t => t.x)), y = Math.min(...tiles.map(t => t.y));
    const w = Math.max(...tiles.map(t => t.x)) - x + 1, h = Math.max(...tiles.map(t => t.y)) - y + 1;
    return { room, tiles, x, y, w, h, horizontal: w > 1, locked: room.rules.access === 'admins' };
  }));
}
