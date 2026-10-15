import { doorwayTiles, roomAt, type Room, type Tile, type TileMap } from '../../shared/map';

export interface RoomDoor {
  room: Room; tiles: Tile[]; x: number; y: number; w: number; h: number; horizontal: boolean;
  locked: boolean; // admins only: stays shut (red light) for everyone else
}
export function roomDoors(m: TileMap): RoomDoor[] {
  const rooms = new Set(m.objects.filter(o => o.sound).map(o => roomAt(m, o.x, o.y)?.id));
  return doorsOf(m, m.rooms.filter(r => r.rules.voice === 'open' || rooms.has(r.id)));
}
/** Doors of rooms only admins may enter: drawn shut (red light) for everyone else. */
export const lockedDoors = (m: TileMap) => doorsOf(m, m.rooms.filter(r => r.rules.access));
function doorsOf(m: TileMap, rooms: Room[]): RoomDoor[] {
  return rooms.flatMap(room => doorwayTiles(m, room).map(tiles => {
    const x = Math.min(...tiles.map(t => t.x)), y = Math.min(...tiles.map(t => t.y));
    const w = Math.max(...tiles.map(t => t.x)) - x + 1, h = Math.max(...tiles.map(t => t.y)) - y + 1;
    return { room, tiles, x, y, w, h, horizontal: w > 1, locked: room.rules.access === 'admins' };
  }));
}
