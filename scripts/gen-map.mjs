// Generates shared/tilemap.json — the single source of truth for the floor.
// Layers are 2D arrays of indices into `tiles` (atlas frame names); 0 = nothing.
// Run: npm run gen (it needs tsx, for the shared layout code)
import { writeFileSync } from 'node:fs';
import { mountainFloor } from './mountain-terrain.mjs';
import { applyLayout, besideObject, findPath, isWalkable, layoutProblem, roomAt } from '../shared/map.ts';

const W = 85, BUILDING_H = 34, OFFICE_H = 44; // x 75-83: the Book Club, east of the Library; the east column above it (x 65-83): the Admin room and Berghain side by side, the 7/11 under both and the Terminal room under that
// the east column (v2): Berghain beside the Admin room, a small 7/11 under both, the Terminal room below
const BERGHAIN = { x: 75, y: 3, w: 9, h: 8 }, SHOP = { x: 65, y: 13, w: 19, h: 6 }, TERMINAL = { x: 65, y: 20, w: 9, h: 3 };
const dungeonRect = { x: 17, y: OFFICE_H + 2, w: 31, h: 19 };
const H = dungeonRect.y + dungeonRect.h;
const SOUTH = 23; // the old outer wall: now the building's back wall, the Orangery and the Garden lie beyond it
const tiles = ['']; // index 0 = empty
const tid = (name) => {
  let i = tiles.indexOf(name);
  if (i < 0) { tiles.push(name); i = tiles.length - 1; }
  return i;
};
const grid = (v = 0) => Array.from({ length: H }, () => Array(W).fill(v));

const floor = grid();
const walls = grid();
const hash = (x, y) => ((x * 73856093) ^ (y * 19349663)) >>> 0;

// the way out: a door in the Lobby's back wall; people leave (and come back in) through it
const EXIT = { x: 12, y: 13 };

// ---- rooms (floor rectangles, walls excluded) ----
const rooms = [
  { id: 'focus', name: 'Focus', type: 'focus', rect: { x: 1, y: 3, w: 12, h: 8 }, capacity: 6,
    floor: 'wood_dark', rug: 'green', homeDesks: true,
    rules: { knock: 'disabled', label: 'quiet · no knocks' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'meeting', name: 'Meeting', type: 'meeting', rect: { x: 14, y: 3, w: 12, h: 8 }, capacity: 8,
    floor: 'wood', rug: 'blue',
    rules: { knock: 'later', occupantLabel: 'in a meeting', label: 'knocks wait for later' },
    meeting: { provider: 'teams', url: 'https://teams.microsoft.com/l/meeting/new' } },
  { id: 'coffee', name: 'Coffee', type: 'coffee', rect: { x: 27, y: 3, w: 12, h: 8 }, capacity: 10,
    floor: 'tile_check', rug: 'orange',
    rules: { voice: 'open', knock: 'allow', label: 'open voice · walk in to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'lobby', name: 'Lobby', type: 'lobby', rect: { x: 1, y: 13, w: 14, h: 10 }, capacity: 30,
    floor: 'wood', rug: 'red',
    rules: { knock: 'allow', label: 'knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'cowork', name: 'Co-working', type: 'cowork', rect: { x: 16, y: 13, w: 23, h: 10 }, capacity: 16,
    floor: 'wood', rug: 'teal', homeDesks: true,
    rules: { knock: 'allow', label: 'knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // east wing (added later; the old outer wall at x=39 is now a divider)
  { id: 'studio', name: 'Studio', type: 'focus', rect: { x: 40, y: 3, w: 13, h: 8 }, capacity: 8,
    floor: 'wood_dark', rug: 'green', homeDesks: true,
    rules: { knock: 'disabled', label: 'quiet · no knocks' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'desks', name: 'Desks', type: 'cowork', rect: { x: 40, y: 13, w: 13, h: 10 }, capacity: 10,
    floor: 'wood', rug: 'blue', homeDesks: true,
    rules: { knock: 'allow', label: 'knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // Music above the Arcade: reached through the new divider door
  { id: 'music', name: 'Music', type: 'music', rect: { x: 54, y: 3, w: 10, h: 8 }, capacity: 12,
    floor: 'wood_dark', rug: 'orange',
    disco: { x: 59, y: 8.5 }, // over the dance floor, clear of the drum kit
    rules: { voice: 'open', knock: 'allow', label: 'jukebox · open voice · walk in to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'arcade', name: 'Arcade', type: 'arcade', rect: { x: 54, y: 13, w: 10, h: 10 }, capacity: 12,
    floor: 'wood_dark', rug: 'teal',
    rules: { voice: 'open', knock: 'allow', label: 'arcade · open voice · walk in to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // south of the building: a glasshouse where plants of people without a home desk stand, and the garden
  { id: 'orangery', name: 'Orangery', type: 'orangery', rect: { x: 1, y: 25, w: 14, h: 8 }, capacity: 12,
    floor: 'tile_check', rug: 'green',
    rules: { knock: 'allow', label: 'plants · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'garden', name: 'Garden', type: 'garden', rect: { x: 16, y: 25, w: 48, h: 8 }, capacity: 30,
    floor: 'grass', rug: 'green',
    rules: { knock: 'allow', label: 'outside · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // the far east column: the servers, reached through the club (only admins get past its door), and the club itself
  { id: 'admin', name: 'Admin', type: 'admin', rect: { x: 65, y: 3, w: 9, h: 8 }, capacity: 4,
    floor: 'raised', rug: 'blue', homeDesks: true,
    rules: { knock: 'allow', access: 'admins', label: 'admins only · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'berghain', name: 'Berghain', type: 'club', rect: BERGHAIN, capacity: 20,
    floor: 'club', rug: 'red',
    rules: { knock: 'allow', label: 'club · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // the dining terrace in the middle of the Garden (last, so it wins the tiles it covers): picnic tables, a food cart
  { id: 'terrace', name: 'Terrace', type: 'garden', rect: { x: 28, y: 26, w: 11, h: 6 }, capacity: 8,
    floor: 'grass', rug: 'orange',
    rules: { knock: 'allow', label: 'lunch outside · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // the Library: the old patch behind the hedge under the club, now walled in; its door opens onto the garden path
  { id: 'library', name: 'Library', type: 'library', rect: { x: 65, y: 25, w: 9, h: 8 }, capacity: 14,
    floor: 'wood_dark', rug: 'burgundy',
    rules: { knock: 'later', occupantLabel: 'reading', label: 'in the library · knocks wait for later' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // the Book Club: through a door in the Library's east wall; armchair talk, so voice is open
  { id: 'bookclub', name: 'Book Club', type: 'library', rect: { x: 75, y: 25, w: 9, h: 8 }, capacity: 8,
    floor: 'wood_dark', rug: 'orange',
    rules: { voice: 'open', knock: 'allow', label: 'book club · open voice · walk in to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'mountains', name: 'Mountains', type: 'vacation', rect: { x: 1, y: 34, w: 24, h: 9 }, capacity: 30,
    floor: 'sand', rug: 'orange', rules: { knock: 'allow', label: 'mountains · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'beach', name: 'Beach', type: 'vacation', rect: { x: 25, y: 34, w: 59, h: 9 }, capacity: 30,
    floor: 'sand', rug: 'orange', rules: { knock: 'allow', label: 'beach · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  // v2 (appended): the convenience store under the Admin room and Berghain, and the room the terminal client lives in
  { id: 'shop', name: '7/11', type: 'shop', rect: SHOP, capacity: 14,
    floor: 'tile_check', rug: 'red',
    rules: { knock: 'allow', label: 'convenience store · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'terminal', name: 'Terminal', type: 'terminal', rect: TERMINAL, capacity: 6,
    floor: 'wood_dark', rug: 'green',
    rules: { knock: 'allow', label: 'terminal · knock to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
];

// ---- base floor everywhere inside the outer walls ----
for (let y = 0; y < BUILDING_H; y++) for (let x = 0; x < W; x++) {
  floor[y][x] = tid(`wood_${hash(x, y) % 3}`);
}
for (const r of rooms.filter(r => r.type !== 'vacation')) {
  for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++)
    for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
      floor[y][x] = r.floor === 'tile_check' ? tid('tile_check')
        : tid(`${r.floor}_${hash(x, y) % 3}`);
    }
}

// ---- walls ----
const CAP = 'wall_cap';
const setWall = (x, y, name) => { walls[y][x] = tid(name); };
for (let x = 0; x < W; x++) { setWall(x, 0, CAP); setWall(x, BUILDING_H - 1, CAP); }
for (let y = 0; y < BUILDING_H; y++) { setWall(0, y, CAP); setWall(W - 1, y, CAP); }
// tall back wall (2 rows of face)
for (let x = 1; x < W - 1; x++) { setWall(x, 1, 'wall_face_top'); setWall(x, 2, 'wall_face_bottom'); }
// horizontal divider: cap row 11, short face row 12, with doors
const hDoors = [6, 7, 19, 20, 32, 33, 46, 47, 58, 59, 82, 83]; // 82-83: Berghain's door onto the 7/11 (it used to be the Admin room's, at 72-73)
for (let x = 1; x < W - 1; x++) {
  if (hDoors.includes(x)) continue;
  setWall(x, 11, CAP); setWall(x, 12, 'wall_face_short');
}
// vertical dividers
for (const vx of [13, 26]) for (let y = 1; y <= 10; y++) {
  if (y === 6 || y === 7) continue;
  setWall(vx, y, CAP);
}
for (let y = 12; y <= 22; y++) { if (y === 17 || y === 18) continue; setWall(15, y, CAP); }
// east wing divider: closed to Coffee (keeps the Studio quiet), a door into Co-working
for (let y = 1; y <= 22; y++) { if (y === 17 || y === 18) continue; setWall(39, y, CAP); }
// music room divider: closed to the Studio, a door from Desks
for (let y = 1; y <= 22; y++) { if (y === 17 || y === 18) continue; setWall(53, y, CAP); }
// the old east wall: closed to the Music room, the club's door from the Arcade
for (let y = 1; y <= 22; y++) { if (y === 17 || y === 18) continue; setWall(64, y, CAP); }
// the building's back wall (row SOUTH) with doors out; brick outside over the garden, wallpaper in the glasshouse
const sDoors = [9, 10, 27, 28, 44, 45, 58, 59];
const LIB_X = 64, LIB_DOOR = [29, 30]; // the Library's west wall, and its door off the garden path
for (let x = 1; x < W - 1; x++) {
  if (sDoors.includes(x)) continue;
  setWall(x, SOUTH, CAP); setWall(x, SOUTH + 1, x < 15 || x > LIB_X ? 'wall_face_short' : x === 15 || x === LIB_X ? CAP : 'wall_face_ext');
}
for (let y = SOUTH; y < BUILDING_H; y++) { if (y === 31 || y === 32) continue; setWall(15, y, CAP); } // Orangery | Garden
// the garden's edge is a hedge, not a wall; the Library east of it is walled in
for (let x = 16; x < LIB_X; x++) setWall(x, BUILDING_H - 1, 'hedge');
for (let y = SOUTH + 2; y < BUILDING_H; y++) if (!LIB_DOOR.includes(y)) setWall(LIB_X, y, CAP);
// the Book Club column (x 74 on): solid above the building's back wall, a door from the Library at rows 29-30
const CLUB_X = 74, CLUB_DOOR = [29, 30];
for (let y = 0; y <= SOUTH; y++) for (let x = CLUB_X; x < W; x++) setWall(x, y, CAP);
for (let y = SOUTH + 2; y < BUILDING_H; y++) if (!CLUB_DOOR.includes(y)) setWall(CLUB_X, y, CAP);
// the east column above (v2): carve Berghain (right of the Admin room), the 7/11 and the Terminal room out of that solid block
const ADMIN_DOOR = [4, 5], SHOP_TERMINAL_DOOR = [68, 69]; // x=74 between Admin and Berghain; row 19 between the shop and the Terminal room
for (const r of [BERGHAIN, SHOP, TERMINAL]) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) walls[y][x] = 0;
for (let x = BERGHAIN.x; x < BERGHAIN.x + BERGHAIN.w; x++) { setWall(x, 1, 'wall_face_top'); setWall(x, 2, 'wall_face_bottom'); }
for (let x = 74; x < W - 1; x++) { if (hDoors.includes(x)) { walls[11][x] = 0; walls[12][x] = 0; } else { setWall(x, 11, CAP); setWall(x, 12, 'wall_face_short'); } }
for (let y = 3; y <= 10; y++) walls[y][74] = ADMIN_DOOR.includes(y) ? 0 : tid(CAP);
for (let y = SHOP.y; y < SHOP.y + SHOP.h; y++) walls[y][74] = 0;
for (let x = SHOP.x; x < SHOP.x + SHOP.w; x++) if (!SHOP_TERMINAL_DOOR.includes(x)) setWall(x, 19, 'wall_face_short');
// door thresholds get plain wood
for (const x of hDoors) for (const y of [11, 12]) floor[y][x] = tid('door_floor');
for (const vx of [13, 26]) for (const y of [6, 7]) floor[y][vx] = tid('door_floor');
for (const y of [17, 18]) for (const x of [15, 39, 53, 64]) floor[y][x] = tid('door_floor');
for (const x of sDoors) for (const y of [SOUTH, SOUTH + 1]) floor[y][x] = tid('door_floor');
for (const y of [31, 32]) floor[y][15] = tid('door_floor');
for (const y of LIB_DOOR) floor[y][LIB_X] = tid('door_floor');
for (const y of CLUB_DOOR) floor[y][CLUB_X] = tid('door_floor');
for (const y of ADMIN_DOOR) floor[y][74] = tid('door_floor');
for (const x of SHOP_TERMINAL_DOOR) floor[19][x] = tid('door_floor');
// garden paths: one along the middle, one from each door down to it, one to the Orangery
{
  const path = (x, y) => { floor[y][x] = tid(`path_${hash(x, y) % 2}`); };
  for (let x = 16; x < LIB_X; x++) path(x, 29);
  for (const x of [27, 28, 44, 45, 58, 59]) for (let y = SOUTH + 2; y < 29; y++) path(x, y);
  for (let x = 16; x < 20; x++) for (const y of [31, 32]) path(x, y);
  for (const x of [18, 19]) path(x, 30);
}

// ---------- vacation: terrain south of the unchanged building ----------
for (let y = BUILDING_H; y < OFFICE_H; y++) for (let x = 0; x < W; x++) {
  floor[y][x] = tid(`${y >= 42 ? 'water_deep' : y >= 41 ? 'water_shallow' : y === 40 ? 'sand_wet' : 'sand'}_${hash(x, y) % 3}`);
  if (y >= 43 || x === 0 || x === W - 1) setWall(x, y, y >= 41 ? 'sea' : 'cliff');
}
const carve = (x, y, family) => { walls[y][x] = 0; floor[y][x] = tid(`${family}_${hash(x, y) % 2}`); };
// A single blocked massif, cut only by the switchback trail.
for (let y = 34; y <= 39; y++) for (let x = 1; x <= 24; x++) {
  const surface = mountainFloor(x, y);
  if (surface === 'snow') carve(x, y, 'snow');
  else if (surface) { walls[y][x] = 0; floor[y][x] = tid(`${surface === 'meadow' ? 'grass' : 'trail'}_mtn_${x}_${y}`); }
  else setWall(x, y, `mtn_${x}_${y}`);
}
for (let y = 39; y <= 42; y++) for (const x of [62, 63]) floor[y][x] = tid('pier');
const vacation = { gate: { x: 50, y: 34 }, trailFoot: { x: 22, y: 38 }, summit: { x: 13, y: 34 },
  pierEnds: [{ x: 62, y: 42 }, { x: 63, y: 42 }],
  swim: [28, 33, 38, 43, 48, 53, 58, 68, 73, 78].map(x => ({ x, y: 42 })) };

// ---- rugs (drawn 9-slice over the floor; admins can move them) ----
const rugs = [];
const rug = (color, x, y, w, h, pattern) => rugs.push({ id: `r${rugs.length + 1}`, color, ...(pattern ? { pattern } : {}), x, y, w, h });
rug('green', 2, 6, 9, 2);
rug('blue', 16, 4, 8, 5, 'plaid');
rug('orange', 28, 5, 9, 3, 'stripes');
rug('red', 3, 15, 9, 5);
rug('teal', 18, 16, 19, 3, 'zigzag');
rug('green', 41, 6, 11, 2, 'dots');
rug('blue', 42, 16, 9, 3, 'checks');
rug('orange', 55, 6, 8, 4); // music room dance floor
rug('burgundy', 65, 26, 9, 7); // the Library, under the reading tables
floor[EXIT.y][EXIT.x] = tid('doormat');

// ---- objects: multi-tile furniture. Footprint blocks walking unless walkable. ----
// Wall decor (wall:true) sits on wall faces and never blocks.
const objects = [];
let oid = 0;
const obj = (type, x, y, w = 1, h = 1, extra = {}) => objects.push({ id: `o${++oid}`, type, x, y, w, h, ...extra });
// what clicking an object offers (see ObjectUse in shared/map.ts)
const LAMP = { light: true, use: { kind: 'toggle', label: 'lamp' }, on: true };
const COFFEE = { kind: 'take', items: [{ id: 'coffee', label: 'Coffee', icon: '☕' }, { id: 'tea', label: 'Tea', icon: '🍵' }] };
const FOOD = { kind: 'take', items: [{ id: 'sandwich', label: 'Sandwich', icon: '🥪' }, { id: 'ramen', label: 'Ramen', icon: '🍜' }, { id: 'salad', label: 'Salad', icon: '🥗' }, { id: 'pizza', label: 'Pizza', icon: '🍕' }] };
const FRIDGE = { kind: 'take', items: [{ id: 'snack', label: 'Snack', icon: '🥪' }, { id: 'juice', label: 'Juice', icon: '🧃' }, { id: 'icecream', label: 'Ice cream', icon: '🍦' }] };

// outer windows & wall decor
for (const wx of [3, 9, 29, 36]) obj('window', wx, 1, 2, 2, { wall: true });
obj('painting', 23, 1, 1, 2, { wall: true });
obj('noticeboard', 2, 12, 2, 1, { wall: true, use: { kind: 'achievements', label: 'achievements' } });
obj('photo_wall', 10, 12, 2, 1, { wall: true, use: { kind: 'photos', label: 'photo wall' } }); // the Lobby photo wall (it took the small painting's wall; the poster next to it moved to x 1)

// Focus: desks with monitors, chairs, a lamp, bookshelf
for (const [dx, dy] of [[2, 4], [5, 4], [8, 4], [2, 8], [9, 8]]) {
  obj('desk', dx, dy, 2, 1);
  obj('chair', dx === 2 ? 3 : dx, dy + 1, 1, 1, { walkable: true });
}
obj('bookshelf', 11, 3, 2, 1);
obj('lamp', 1, 10, 1, 1, LAMP);
obj('plant', 1, 3, 1, 1);
obj('lamp', 12, 10, 1, 1, LAMP);

// Meeting: long table, chairs around, plants
obj('table_long', 17, 5, 6, 2);
for (const x of [17, 19, 21]) obj('chair', x, 4, 1, 1, { walkable: true });
for (const x of [18, 20, 22]) obj('chair', x, 7, 1, 1, { walkable: true });
obj('chair', 16, 6, 1, 1, { walkable: true });
obj('chair', 23, 5, 1, 1, { walkable: true });
obj('plant', 14, 3, 1, 1);
obj('plant', 25, 10, 1, 1);

// Coffee: counter + machine + fridge, tables with stools, sofa
for (const x of [28, 29, 30, 31, 33, 34]) obj('counter', x, 3, 1, 1);
obj('coffee_machine', 32, 3, 1, 1, { steam: true, use: COFFEE });
obj('fridge', 36, 3, 1, 1, { use: FRIDGE });
obj('plant', 38, 3, 1, 1);
obj('table_round', 30, 6, 1, 1);
obj('table_round', 35, 6, 1, 1);
for (const x of [29, 31, 34, 36]) obj('stool', x, 6, 1, 1, { walkable: true });
obj('sofa', 29, 9, 3, 1, { sit: true, dir: 'down' }); // each tile is a seat; you sit down from the tile in front
obj('plant', 38, 10, 1, 1);

// Lobby: plants, sofa, reception, coffee table
obj('plant', 1, 13, 1, 1);
obj('plant', 14, 13, 1, 1);
obj('sofa', 5, 16, 3, 1, { sit: true, dir: 'down' });
obj('table_round', 6, 18, 1, 1);
obj('reception', 10, 14, 3, 1);
// Co-working's world clocks: real time with moving hands; clicking one opens the list of our cities
obj('clock_nyc', 24, 12, 1, 1, { wall: true, use: { kind: 'clock', label: 'NYC', city: 'New York', tz: 'America/New_York' } });
obj('clock_berlin', 26, 12, 1, 1, { wall: true, use: { kind: 'clock', label: 'BERLIN', city: 'Berlin', tz: 'Europe/Berlin' } });
obj('clock_moscow', 28, 12, 1, 1, { wall: true, use: { kind: 'clock', label: 'MOSCOW', city: 'Moscow', tz: 'Europe/Moscow' } });
obj('safe', 8, 12, 2, 1, { wall: true, use: { kind: 'link', label: 'vault', url: 'https://vault13.t1a.cloud/' } }); // Vault 13's door, set in the wall by reception
obj('plant', 1, 22, 1, 1);
obj('bookshelf', 12, 21, 2, 1);
obj('hat_rack', 1, 18, 2, 1, { use: { kind: 'dealer', label: 'hat stand', items: ['hat:top', 'hat:party', 'hat:wizard', 'hat:cowboy', 'hat:crown'] } }); // hats go into your pockets

// Co-working: four-seat tables
for (const tx of [18, 23, 28, 33]) for (const ty of [14, 19]) {
  obj('table_big', tx, ty, 2, 2);
  obj('chair', tx - 1, ty + 1, 1, 1, { walkable: true });
  obj('chair', tx + 2, ty + 1, 1, 1, { walkable: true });
}
obj('plant', 38, 13, 1, 1);
obj('plant', 16, 22, 1, 1);
obj('lamp', 38, 22, 1, 1, LAMP);

// Lobby exit door (last, so earlier object ids stay put)
obj('exit_door', EXIT.x, 12, 1, 1, { wall: true });
// more lamps to flick on and off (after the door, same reason)
obj('lamp', 2, 22, 1, 1, LAMP);
obj('lamp', 27, 10, 1, 1, LAMP);
obj('lamp', 14, 10, 1, 1, LAMP);

// on the west wall beside the dance floor: fills the Music room (rooms are sealed, nothing leaks out)
obj('jukebox', 54, 7, 2, 2, { sound: { gain: 0.8 }, use: { kind: 'jukebox', label: 'jukebox' } });

// wall calendars: click to see your own Google Calendar (after the jukebox, same reason)
const CALENDAR = { wall: true, use: { kind: 'calendar', label: 'calendar' } };
obj('calendar', 34, 1, 1, 1, CALENDAR); // Coffee, between the windows
obj('calendar', 22, 12, 1, 1, CALENDAR); // Co-working
// the board by the Meeting room's door: which calendar meetings are on in their own rooms
obj('meetings_board', 18, 12, 1, 1, { wall: true, use: { kind: 'meetings', label: 'meetings' } });

// east wing (after everything above, same reason)
for (const wx of [42, 49]) obj('window', wx, 1, 2, 2, { wall: true });
obj('painting', 45, 1, 1, 2, { wall: true });
obj('painting_small', 50, 12, 1, 1, { wall: true });
// Studio: two rows of desks, an aisle down from the door at x 46-47
for (const [dx, dy] of [[41, 4], [44, 4], [47, 4], [50, 4], [41, 8], [43, 8], [48, 8], [50, 8]]) {
  obj('desk', dx, dy, 2, 1);
  obj('chair', dx, dy + 1, 1, 1, { walkable: true });
}
obj('plant', 40, 3, 1, 1);
obj('lamp', 52, 3, 1, 1, LAMP);
obj('plant', 52, 10, 1, 1);
// Desks: a row along the top and one along the bottom, a rug and sofa between
for (const [dx, dy] of [[41, 13], [44, 13], [48, 13], [51, 13], [41, 20], [44, 20], [48, 20], [51, 20]]) {
  obj('desk', dx, dy, 2, 1);
  obj('chair', dx, dy + 1, 1, 1, { walkable: true });
}
obj('sofa', 45, 17, 3, 1, { sit: true, dir: 'down' });
obj('plant', 40, 22, 1, 1);
obj('lamp', 40, 16, 1, 1, LAMP);
// Music room (after the east wing, same reason): windows, tables with stools, sofas along the bottom
obj('window', 55, 1, 2, 2, { wall: true });
obj('lofi_tv', 59, 1, 4, 2, { wall: true, use: { kind: 'youtube', label: 'Lofi Girl · YouTube Live', room: 'music' } });
obj('plant', 54, 3, 1, 1);
obj('plant', 63, 3, 1, 1);
// Six replacements for the tables/stools: keep every later object id stable.
for (const x of [54, 56, 61]) obj('arcade', x, 13, 1, 2, { use: { kind: 'arcade', label: 'Deck Park', game: 'park' } });
obj('records', 62, 12, 2, 1, { wall: true, use: { kind: 'records', label: 'records' } });
obj('plant', 63, 20);
obj('painting_small', 55, 12, 1, 1, { wall: true }); // padding for the sixth old object
rug('teal', 56, 16, 6, 3, 'plain');
obj('sofa', 55, 21, 3, 1, { sit: true, dir: 'down' });
obj('sofa', 60, 21, 3, 1, { sit: true, dir: 'down' });
obj('lamp', 54, 22, 1, 1, LAMP);
obj('lamp', 63, 22, 1, 1, LAMP);

// Orangery and Garden (last, so earlier object ids stay put). Plant shelves: every tile is a slot for someone's plant.
for (const y of [26, 28, 30]) for (const x of [2, 10]) obj('plant_shelf', x, y, 4, 1);
obj('plant', 1, 25, 1, 1);
obj('plant', 14, 25, 1, 1);
obj('lamp', 1, 32, 1, 1, LAMP);
for (const [x, y] of [[17, 26], [24, 31], [33, 26], [38, 31], [51, 26], [54, 31], [62, 26], [48, 31], [63, 31]]) obj('tree', x, y, 1, 1);
for (const [x, y] of [[21, 31], [30, 31], [40, 26], [55, 26], [60, 31]]) obj('flowerbed', x, y, 2, 1);
obj('pond', 41, 30, 4, 2);
obj('bench', 21, 26, 3, 1, { sit: true, dir: 'down' });
obj('bench', 47, 26, 3, 1, { sit: true, dir: 'down' });
obj('bench', 34, 31, 3, 1, { sit: true, dir: 'down' });

// Music room stage, appended to preserve existing object ids.
obj('keyboard', 55, 4, 2, 1, { use: { kind: 'instrument', instrument: 'keys', label: 'keys' } });
obj('drum_kit', 58, 4, 2, 2, { use: { kind: 'instrument', instrument: 'drums', label: 'drums' } });
obj('bass_amp', 61, 4, 1, 1, { use: { kind: 'instrument', instrument: 'bass', label: 'bass' } });

// the Meeting room's one board (the old whiteboard's spot is part of it): upload slides (PIN) and present them to the room (appended, same reason)
obj('screen', 18, 1, 5, 2, { wall: true, use: { kind: 'presentation', label: 'screen' } });
// the Admin room and Berghain (last, so earlier object ids stay put)
obj('window', 71, 1, 2, 2, { wall: true });
for (const y of [3, 7]) for (let x = 65; x <= 69; x++) obj('server_rack', x, y);
obj('desk', 71, 4, 2, 1);
obj('chair', 71, 5, 1, 1, { walkable: true });
obj('plant', 73, 7);
obj('neon_sign', 78, 2, 2, 1, { wall: true });
obj('dj_booth', 77, 3, 3, 1, { sound: { gain: 0.8 }, use: { kind: 'jukebox', label: 'DJ booth', genres: ['Techno'] } }); // plays techno only
obj('bouncer', 83, 9, 1, 1, { use: { kind: 'dealer', label: 'bouncer', items: ['drugs'] } }); // right by the door from the 7/11; knows a guy
obj('lamp', 83, 3, 1, 1, LAMP);
for (const x of [76, 78, 80]) obj('toilet', x, 9, 2, 2, { use: { kind: 'toilet', label: 'toilet' } });
// the Library's tall shelves, in place of the trees of the patch it was built on (same ids); the middle one is the
// shelf you publish to and borrow from
for (const x of [66, 69, 72]) obj('bookshelf_tall', x, 25, 2, 1, x === 69 ? { use: { kind: 'library', label: 'library' } } : {});

// Berghain's dance floor (appended: object ids stay put): step on and dance
obj('dance_floor', 79, 5, 4, 3, { walkable: true, use: { kind: 'dance', label: 'dance floor' } });
// two one-seat reading desks along the Library's east wall (the reading tables come last, so ids here stay put)
for (const y of [27, 31]) {
  obj('reading_desk', 73, y);
  obj('chair', 73, y + 1, 1, 1, { walkable: true });
}
// the dining terrace (last, so earlier object ids stay put): two picnic tables with chairs on both sides, staggered so
// the plates in front of facing diners land on different tiles, and a food cart
for (const tx of [29, 34]) {
  obj('table_picnic', tx, 27, 3, 1);
  obj('chair', tx, 26, 1, 1, { walkable: true });
  obj('chair', tx + 2, 26, 1, 1, { walkable: true });
  obj('chair', tx + 1, 28, 1, 1, { walkable: true });
}
obj('food_cart', 32, 31, 2, 1, { use: FOOD });

obj('game_table', 58, 17, 2, 1, { use: { kind: 'table', label: 'Game table' } });

// ---- standing spots (seats follow the furniture: applyLayout in shared/map.ts) ----
for (const r of rooms) r.stand = [];
const stand = (id, list) => rooms.find(r => r.id === id).stand.push(...list.map(([x, y, dir]) => ({ x, y, dir })));
stand('coffee', [[30, 8, 'down'], [31, 8, 'down'], [33, 5, 'up'], [29, 4, 'up'], [37, 7, 'left']]);
stand('lobby', [[4, 17, 'down'], [8, 17, 'down'], [6, 20, 'down'], [11, 15, 'up'], [3, 19, 'right']]);
stand('focus', [[7, 7, 'down']]);
stand('meeting', [[19, 9, 'up'], [24, 8, 'left']]);
stand('cowork', [[25, 17, 'down'], [31, 18, 'down'], [36, 13, 'down']]);
stand('studio', [[46, 7, 'down']]);
stand('desks', [[42, 17, 'right'], [50, 18, 'left']]);
stand('music', [[57, 7, 'up'], [60, 8, 'up'], [58, 10, 'up']]);
stand('arcade', [[55, 16, 'up'], [61, 16, 'up'], [58, 19, 'up']]);
stand('orangery', [[7, 27, 'down'], [8, 29, 'down'], [7, 31, 'down']]);
stand('admin', [[70, 9, 'left']]);
stand('berghain', [[77, 6, 'down'], [82, 8, 'left'], [78, 4, 'down']]);
stand('shop', [[71, 15, 'down'], [75, 15, 'down'], [69, 18, 'up'], [82, 17, 'left']]);
stand('terminal', [[69, 20, 'down']]);
stand('library', [[68, 25, 'up'], [71, 25, 'up']]);
stand('garden', [[42, 29, 'down'], [43, 29, 'down'], [33, 29, 'left'], [56, 28, 'down'], [20, 28, 'down']]);
stand('mountains', [[2, 38, 'down'], [24, 39, 'down'], [22, 38, 'left'], [13, 34, 'down']]);
stand('beach', [[28, 38, 'down'], [42, 38, 'down'], [52, 38, 'down'], [70, 38, 'down'], [80, 39, 'down']]);

// ---- a separate, deterministic maze under the garden (never furniture) ----
const random = (() => { let seed = 16; return () => {
  let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296;
}; })();
const pick = list => list[Math.floor(random() * list.length)];
const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const maze = Array.from({ length: 19 }, () => Array(31).fill(false));
const stack = [[1, 1]]; maze[1][1] = true;
while (stack.length) {
  const [x, y] = stack.at(-1);
  const options = dirs.map(([dx, dy]) => [x + dx * 2, y + dy * 2])
    .filter(([x, y]) => x > 0 && x < 30 && y > 0 && y < 18 && !maze[y][x]);
  if (!options.length) { stack.pop(); continue; }
  const [nx, ny] = pick(options); maze[(y + ny) / 2][(x + nx) / 2] = maze[ny][nx] = true; stack.push([nx, ny]);
}
// Remove only separating walls, keeping the outer wall intact.
for (let i = 0; i < 10; i++) {
  const options = [];
  for (let y = 1; y < 18; y++) for (let x = 1; x < 30; x++) if (!maze[y][x] &&
    ((x % 2 === 0 && y % 2 === 1 && maze[y][x - 1] && maze[y][x + 1]) ||
     (y % 2 === 0 && x % 2 === 1 && maze[y - 1][x] && maze[y + 1][x]))) options.push([x, y]);
  const [x, y] = pick(options); maze[y][x] = true;
}
const landing = { x: 3, y: 9 };
for (let y = 8; y <= 10; y++) for (let x = 2; x <= 4; x++) maze[y][x] = true;
const distances = () => {
  const dist = maze.map(row => row.map(() => -1)), queue = [landing]; dist[landing.y][landing.x] = 0;
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of dirs) {
    const x = queue[i].x + dx, y = queue[i].y + dy;
    if (maze[y]?.[x] && dist[y][x] < 0) { dist[y][x] = dist[queue[i].y][queue[i].x] + 1; queue.push({ x, y }); }
  }
  return dist;
};
let dist = distances();
const boundary = [];
for (let y = 1; y <= 17; y += 2) for (let x = 1; x <= 29; x += 2)
  if (x === 1 || x === 29 || y === 1 || y === 17) boundary.push({ x, y });
const doorFront = boundary.sort((a, b) => dist[b.y][b.x] - dist[a.y][a.x])[0];
const outward = doorFront.y === 1 ? { x: 0, y: -1 } : doorFront.y === 17 ? { x: 0, y: 1 }
  : { x: doorFront.x === 1 ? -1 : 1, y: 0 };
const door = { x: doorFront.x + outward.x, y: doorFront.y + outward.y, w: 1, h: 1 };
const chamber = new Set();
for (let depth = 0; depth < 2; depth++) for (let side = -1; side <= 1; side++) {
  const x = doorFront.x - outward.x * depth + outward.y * side;
  const y = doorFront.y - outward.y * depth + outward.x * side;
  if (x > 0 && x < 30 && y > 0 && y < 18) { maze[y][x] = true; chamber.add(`${x},${y}`); }
}
dist = distances();
const farthest = Math.max(...dist.flat()), keySpots = [];
for (let y = 1; y < 18; y++) for (let x = 1; x < 30; x++) if (maze[y][x] && dist[y][x] >= farthest * .4 &&
  !chamber.has(`${x},${y}`) && dirs.filter(([dx, dy]) => maze[y + dy]?.[x + dx]).length === 1) keySpots.push({ x, y });
if (keySpots.length < 6) throw new Error(`maze needs at least 6 distant dead ends, got ${keySpots.length}; change seed`);
const torches = [], torchWalls = [];
for (let y = 1; y < 18; y++) for (let x = 1; x < 30; x++) if (!maze[y][x] && maze[y + 1]?.[x] &&
  Math.abs(x - landing.x) + Math.abs(y - landing.y) > 4 && Math.abs(x - door.x) + Math.abs(y - door.y) > 4) torchWalls.push({ x, y });
while (torches.length < 7) {
  const options = torchWalls.filter(t => torches.every(p => Math.abs(p.x - t.x) + Math.abs(p.y - t.y) >= 5));
  if (!options.length) throw new Error('not enough spaced torch walls'); torches.push(pick(options));
}
const decor = [{ type: 'leaves', x: landing.x, y: landing.y + 1 }], decals = ['bones', 'cobweb', 'puddle', 'rubble'];
const decorTiles = [];
for (let y = 1; y < 18; y++) for (let x = 1; x < 30; x++) if (maze[y][x] &&
  ![landing, doorFront, ...keySpots].some(t => t.x === x && t.y === y)) decorTiles.push({ x, y });
while (decor.length < 12) {
  const t = pick(decorTiles.filter(t => !decor.some(p => p.x === t.x && p.y === t.y)));
  const corner = !maze[t.y - 1][t.x] && (!maze[t.y][t.x - 1] || !maze[t.y][t.x + 1]);
  decor.push({ type: corner ? 'cobweb' : pick(decals.filter(d => d !== 'cobweb')), ...t });
}
for (let y = OFFICE_H; y < H; y++) for (let x = 0; x < W; x++) { floor[y][x] = 0; walls[y][x] = tid('void'); }
for (let y = 0; y < 19; y++) for (let x = 0; x < 31; x++) {
  const xx = dungeonRect.x + x, yy = dungeonRect.y + y;
  floor[yy][xx] = tid(`dungeon_floor_${hash(x, y) % 3}`);
  walls[yy][xx] = maze[y][x] ? 0 : tid(maze[y + 1]?.[x] ? 'dungeon_wall_face' : 'dungeon_wall');
}
const absolute = t => ({ ...t, x: t.x + dungeonRect.x, y: t.y + dungeonRect.y });
const dungeon = { rect: dungeonRect, hole: { x: 63, y: 25 }, hatch: { x: 20, y: 32 }, landing: absolute(landing),
  door: absolute(door), doorFront: absolute(doorFront), keySpots: keySpots.map(absolute), torches: torches.map(absolute), decor: decor.map(absolute) };
walls[dungeon.door.y][dungeon.door.x] = tid('dungeon_door_closed');
for (const k of ['hole', 'hatch']) {
  const t = dungeon[k];
  if (!tiles[floor[t.y][t.x]].startsWith('grass_') || objects.some(o => t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h) ||
    rooms.some(r => r.stand.some(s => s.x === t.x && s.y === t.y))) throw new Error(`${k} must be free grass off paths and spots`);
  floor[t.y][t.x] = tid(k);
}

// one of each kind of object, for admins to add more of
const catalog = {};
for (const { id: _i, x: _x, y: _y, ...t } of objects) catalog[t.type] ??= t;

obj('bell', 11, 14, 1, 1, { onTop: true, use: { kind: 'bell', label: 'bell' } }); // on the reception counter

// the Library's reading tables (after the bell, so every earlier id stays put): long dark tables with a green banker's
// lamp each, in two rows of three; a chair on each side, staggered so the readers don't sit nose to nose
const firstTable = objects.length;
for (const ty of [27, 31]) for (const tx of [65, 68, 71]) {
  obj('reading_table', tx, ty, 2, 1, { light: true });
  obj('chair', tx, ty - 1, 1, 1, { walkable: true });
  obj('chair', tx + 1, ty + 1, 1, 1, { walkable: true });
}
for (const { id: _i, x: _x, y: _y, ...t } of objects.slice(firstTable)) catalog[t.type] ??= t;

// more plants, furniture and wall decor (appended last so every earlier id stays put). Floor pieces hug the walls so they
// never block a path; wall pieces go on free wall faces between the windows.
const firstDecor = objects.length;
for (const [type, ...at] of [
  ['palm', 1, 15], ['water_cooler', 14, 16], ['coat_stand', 14, 14], ['side_table', 1, 20], // Lobby
  ['fern', 1, 26], ['planter', 5, 25], ['planter', 11, 25], ['cactus', 14, 27], // Orangery
  ['floor_lamp', 54, 5], ['palm', 63, 5], // Music
  ['palm', 65, 5], ['floor_lamp', 73, 5], // Admin
  ['fern', 73, 30], ['side_table', 65, 32], // Library
]) obj(type, ...at, type === 'planter' ? 2 : 1, 1);
for (const [type, x, y, w = 1, h = 1] of [
  ['wall_shelf', 6, 2, 2], ['wall_ivy', 12, 2], ['poster', 1, 2],
  ['poster', 15, 2], ['wall_ivy', 16, 2], ['poster', 25, 2],
  ['wall_shelf', 27, 2, 2], ['wall_ivy', 32, 2], ['poster', 35, 2],
  ['wall_shelf', 46, 2, 2], ['poster', 44, 2], ['wall_ivy', 51, 2],
  ['poster', 58, 2], ['wall_ivy', 63, 2],
  ['wall_shelf', 66, 2, 2], ['mirror', 68, 1, 1, 2], ['poster', 70, 2],
  ['poster', 1, 12], ['mirror', 13, 11, 1, 2],
]) obj(type, x, y, w, h, type === 'mirror' ? { wall: true, use: { kind: 'mirror', label: 'mirror' } } : { wall: true }); // a mirror opens Edit look
for (const { id: _i, x: _x, y: _y, ...t } of objects.slice(firstDecor)) catalog[t.type] ??= t;
// edit-mode only: these are not placed anywhere, an admin adds them from the catalog (art in gen-assets.mjs, "the edit-mode catalog")
for (const type of ['succulent', 'bonsai', 'snake_plant', 'monstera', 'orchid', 'tulips', 'sunflower', 'bamboo', 'ficus', 'lavender',
  'filing_cabinet', 'printer', 'vending_machine', 'mini_fridge', 'globe', 'trophy', 'speaker', 'umbrella_stand', 'boxes', 'barrel', 'vase_floor', 'statue']) catalog[type] ??= { type, w: 1, h: 1 };
for (const type of ['aquarium', 'tv_stand', 'credenza', 'shelf_low']) catalog[type] ??= { type, w: 2, h: 1 };
for (const type of ['wall_clock', 'dartboard', 'cork_board', 'diploma', 'fire_extinguisher', 'exit_sign', 'wall_sconce', 'neon_heart', 'record_wall']) catalog[type] ??= { type, w: 1, h: 1, wall: true };
for (const type of ['wall_tv', 'pennants', 'wall_plants', 'whiteboard_small']) catalog[type] ??= { type, w: 2, h: 1, wall: true };
catalog.banner ??= { type: 'banner', w: 1, h: 2, wall: true };

// the Book Club (last, so every earlier id stays put): shelves on the back wall, a sofa and armchairs round a low table
const firstClub = objects.length;
for (const x of [76, 81]) obj('bookshelf_tall', x, 25, 2, 1);
obj('sofa', 78, 27, 3, 1, { sit: true, dir: 'down' });
obj('table_round', 79, 29, 1, 1);
// v2: the audience sits in a row facing the leader's chair and desk at the south end (the fifth chair is the leader's)
for (const [x, y] of [[77, 29], [78, 29], [80, 29], [81, 29]]) obj('chair', x, y, 1, 1, { walkable: true, dir: 'down', turned: true });
obj('leader_chair', 79, 32, 1, 1, { walkable: true, dir: 'up', turned: true }); // a later session wires shared reading to it
obj('lamp', 83, 26, 1, 1, LAMP);
obj('lamp', 75, 32, 1, 1, LAMP);
obj('plant', 83, 32);
rug('orange', 77, 28, 5, 4);
for (const { id: _i, x: _x, y: _y, ...t } of objects.slice(firstClub)) catalog[t.type] ??= t;
rooms.find(r => r.id === 'bookclub').stand.push({ x: 82, y: 29, dir: 'left' });
// the Meeting room's booking kiosk, just inside the door from Co-working so everyone walks past it (last, so every earlier id stays put)
obj('room_start', 21, 10, 1, 1, { use: { kind: 'room_start', label: 'start private room' } });

// Retro cabinets appended last: all existing object ids stay stable.
const firstRetro = objects.length;
obj('retro_tobu', 62, 13, 1, 2, { use: { kind: 'retro', label: 'Tobu Tobu Girl', game: 'tobu' } });
obj('retro_lobster', 63, 13, 1, 2, { use: { kind: 'retro', label: 'Shock Lobster', game: 'lobster' } });
for (const { id: _i, x: _x, y: _y, ...t } of objects.slice(firstRetro)) catalog[t.type] ??= t;

// Lobby: the bug terminal (before the wing: its furniture stays last)
obj('suggestions_board', 4, 12, 2, 1, { wall: true, use: { kind: 'tickets', label: 'suggestions board' } }); // Lobby wall: suggestions and bug reports, the replies (admins: the queue)

// ---------- vacation: props appended after all existing objects ----------
const firstVacation = objects.length;
// Check against the complete building furniture before opening the closest free garden pair.
const freeGarden = x => !walls[32][x] && !objects.some(o => !o.wall && !o.walkable && x >= o.x && x < o.x + o.w && 32 >= o.y && 32 < o.y + o.h);
const gateX = Array.from({ length: 47 }, (_, i) => i + 16).sort((a, b) => Math.abs(a - 50) - Math.abs(b - 50) || a - b).find(x => freeGarden(x) && freeGarden(x + 1));
if (gateX === undefined) throw new Error('no free garden pair for the vacation gate');
for (const x of [gateX, gateX + 1]) { walls[33][x] = 0; floor[33][x] = tid('door_floor'); }
vacation.gate.x = gateX;
for (const [x, y] of [[29, 35], [35, 35], [57, 35], [80, 35]]) obj('palm', x, y);
for (const [x, y] of [[2, 37], [1, 39], [23, 36]]) obj('pine', x, y);
for (const x of [30, 46, 62, 78]) {
  obj('lounger', x, 37, 2, 1, { lie: true, dir: 'down' });
  obj('umbrella', x, 36);
}
obj('hammock', 31, 35, 3, 1, { lie: true, dir: 'down' });
obj('beach_bar', 65, 35, 3, 1, { use: { kind: 'take', items: [
  { id: 'cocktail', label: 'Cocktail', icon: '🍹' }, { id: 'beer', label: 'Beer', icon: '🍺' }, { id: 'wine', label: 'Wine', icon: '🍷' }, // alcohol: drinking gets you drunk (shared/drinks.ts)
  { id: 'coconut', label: 'Coconut', icon: '🥥' }, { id: 'icecream', label: 'Ice cream', icon: '🍦' },
] } });
obj('vacation_sign', gateX + 2, 34, 1, 1, { use: { kind: 'vacations' } });
obj('summit_flag', 12, 34);
obj('sandcastle', 40, 39);
obj('shells', 59, 40);
obj('beach_ball', 75, 38);
for (const { id: _i, x: _x, y: _y, ...t } of objects.slice(firstVacation)) catalog[t.type] ??= t;


// Personal breaks, appended so saved object ids stay stable.
const firstWellness = objects.length;
obj('wellness_cooler', 37, 3, 1, 1, { use: { kind: 'wellness', activity: 'water', label: 'Water cooler' } });
obj('stretch_mat', 20, 30, 2, 1, { walkable: true, use: { kind: 'wellness', activity: 'stretch', label: 'Stretching mat' } });
for (const { id: _i, x: _x, y: _y, ...t } of objects.slice(firstWellness)) catalog[t.type] ??= t;

// Appended to preserve saved furniture ids. The broad sign sits on dry sand, clear of the gate and pier.
obj('out_of_office_sign', 48, 39, 7, 1);
catalog.out_of_office_sign = { type: 'out_of_office_sign', w: 7, h: 1 };

// ---------- v2 places: appended after all existing objects ----------
const firstPlaces = objects.length;
// the 7/11 (x 65-83, y 13-18): a TV in the corner and a neon sign on the back wall, gondola shelves, the counter with Keiko behind it, the gacha machine by the door
obj('shop_tv', 65, 12, 2, 1, { wall: true });
obj('shop_sign', 70, 12, 4, 1, { wall: true });
obj('gacha_machine', 65, 15, 1, 2, { use: { kind: 'gacha', label: 'gacha machine' } });
for (const [x, y] of [[68, 14], [72, 14], [76, 14], [68, 16], [72, 16], [76, 16]]) obj('shop_shelf', x, y, 3, 1, { use: { kind: 'shop', label: 'shelves' } });
obj('shop_counter', 79, 16, 3, 1, { use: { kind: 'cashier', label: 'Keiko' } });
obj('keiko', 80, 15, 1, 1); // the cashier: a map object like the bouncer (name tag, idle bubbles on the client, checkout lines from the server)
obj('plant', 83, 18);
// the Terminal room: three consoles (desk + chair) along the south wall
for (const x of [66, 69, 72]) { obj('desk', x, 21, 2, 1); obj('chair', x, 22, 1, 1, { walkable: true }); }
obj('plant', 65, 20);
// the kitchen (Coffee): a kettle on the counter for cup noodles, one bigger bar table to eat at standing up
obj('kettle', 35, 3, 1, 1, { steam: true, use: { kind: 'kettle', label: 'kettle' } });
obj('bar_table', 34, 8, 3, 1);
// Book Club: the leader's small desk, in front of the leader's chair
obj('leader_desk', 79, 31, 1, 1);
// Co-working: the glass trophy case is the physical achievement board
obj('trophy_case', 31, 22, 2, 1, { use: { kind: 'achievements', label: 'trophy case' } });
for (const { id: _i, x: _x, y: _y, ...t } of objects.slice(firstPlaces)) catalog[t.type] ??= t;

const map = { version: 1, width: W, height: H, tileSize: 16, office: { x: 0, y: 0, w: W, h: OFFICE_H }, dungeon, vacation, tiles, layers: { floor, walls, walkable: [] }, rooms, objects: [], rugs: [], spawn: { x: 7, y: 17 }, exit: EXIT, catalog };
applyLayout(map, { objects, rugs });
for (const r of rooms) for (const s of r.stand) if (!r.spots.includes(s)) throw new Error(`standing spot ${r.id} ${s.x},${s.y} is under furniture`);
if (findPath(map, map.spawn, dungeon.landing).length) throw new Error('dungeon connected to office');
for (const t of dungeon.decor) if (!isWalkable(map, t.x, t.y) || [dungeon.landing, dungeon.doorFront, ...dungeon.keySpots].some(p => p.x === t.x && p.y === t.y)) throw new Error('decor covers a dungeon destination');
for (const t of [...dungeon.keySpots, dungeon.doorFront]) if (!findPath(map, dungeon.landing, t).length) throw new Error('unreachable dungeon destination');
for (const k of ['hole', 'hatch']) {
  const t = dungeon[k];
  if (!isWalkable(map, t.x, t.y) || roomAt(map, t.x, t.y)?.id !== 'garden' || !findPath(map, map.spawn, t).length) throw new Error(`unreachable garden ${k}`);
}
for (const t of [vacation.gate, vacation.trailFoot, vacation.summit, ...vacation.pierEnds, ...vacation.swim])
  if (!isWalkable(map, t.x, t.y) || !findPath(map, map.spawn, t).length) throw new Error(`unreachable vacation destination ${t.x},${t.y}`);
const problem = layoutProblem(map);
if (problem) throw new Error(problem);
for (const o of objects) if ((o.use?.kind === 'arcade' || o.use?.kind === 'retro') && !besideObject(map, o).some(t => findPath(map, map.spawn, t).length)) throw new Error(`unreachable cabinet ${o.id}`);
for (const x of [58, 59]) if (!findPath(map, map.spawn, { x, y: 11 }).length) throw new Error('Music door is unreachable');
const admin = rooms.find(r => r.id === 'admin').rect;
if (!findPath(map, map.spawn, { x: admin.x + 7, y: admin.y + 7 }).length) throw new Error('Admin room is unreachable');
if (findPath(map, map.spawn, { x: admin.x + 7, y: admin.y + 7 }, true).length) throw new Error('non-admins can walk into the Admin room');
for (const r of rooms) if (r.id !== 'admin' && r.stand.some(s => !findPath(map, map.spawn, s, true).length)) throw new Error(`${r.name} is only reachable through the Admin room`);
{
  const lib = rooms.find(r => r.id === 'library');
  if (lib.spots.filter(s => objects.some(o => o.type === 'chair' && o.x === s.x && o.y === s.y)).length < 6) throw new Error('the Library seats fewer than six');
  if (lib.stand.some(s => !findPath(map, map.spawn, s, true).length)) throw new Error('the Library is unreachable');
}
{
  const club = rooms.find(r => r.id === 'bookclub');
  if (club.stand.some(s => !findPath(map, map.spawn, s, true).length)) throw new Error('the Book Club is unreachable');
  if (club.spots.length < 6) throw new Error('the Book Club seats fewer than six');
}
writeFileSync(new URL('../shared/tilemap.json', import.meta.url), JSON.stringify(map));
console.log(`tilemap: ${W}x${H}, ${tiles.length - 1} tile kinds, ${objects.length} objects, ${rugs.length} rugs, ${rooms.reduce((n, r) => n + r.spots.length, 0)} spots`);
