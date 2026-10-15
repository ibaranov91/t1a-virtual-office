// Generates shared/tilemap.json — the single source of truth for the floor.
// Layers are 2D arrays of indices into `tiles` (atlas frame names); 0 = nothing.
// Run: node scripts/gen-map.mjs
import { writeFileSync } from 'node:fs';

const W = 65, H = 34;
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
  // music room at the east end, full height: the radio plays here so the rest of the office stays quiet
  { id: 'music', name: 'Music', type: 'music', rect: { x: 54, y: 3, w: 10, h: 20 }, capacity: 12,
    floor: 'wood_dark', rug: 'orange',
    rules: { knock: 'allow', label: 'radio · knock to talk' },
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
];

// ---- base floor everywhere inside the outer walls ----
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  floor[y][x] = tid(`wood_${hash(x, y) % 3}`);
}
for (const r of rooms) {
  for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++)
    for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
      floor[y][x] = r.floor === 'tile_check' ? tid('tile_check')
        : tid(`${r.floor}_${hash(x, y) % 3}`);
    }
}

// ---- walls ----
const CAP = 'wall_cap';
const setWall = (x, y, name) => { walls[y][x] = tid(name); };
for (let x = 0; x < W; x++) { setWall(x, 0, CAP); setWall(x, H - 1, CAP); }
for (let y = 0; y < H; y++) { setWall(0, y, CAP); setWall(W - 1, y, CAP); }
// tall back wall (2 rows of face)
for (let x = 1; x < W - 1; x++) { setWall(x, 1, 'wall_face_top'); setWall(x, 2, 'wall_face_bottom'); }
// horizontal divider: cap row 11, short face row 12, with doors
const hDoors = [6, 7, 19, 20, 32, 33, 46, 47];
for (let x = 1; x < W - 1; x++) {
  if (hDoors.includes(x) || x >= 54) continue; // the music room runs the full height
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
// the building's back wall (row SOUTH) with doors out; brick outside over the garden, wallpaper in the glasshouse
const sDoors = [9, 10, 27, 28, 44, 45, 58, 59];
for (let x = 1; x < W - 1; x++) {
  if (sDoors.includes(x)) continue;
  setWall(x, SOUTH, CAP); setWall(x, SOUTH + 1, x < 15 ? 'wall_face_short' : x === 15 ? CAP : 'wall_face_ext');
}
for (let y = SOUTH; y < H; y++) { if (y === 31 || y === 32) continue; setWall(15, y, CAP); } // Orangery | Garden
// the garden's edge is a hedge, not a wall
for (let x = 16; x < W; x++) setWall(x, H - 1, 'hedge');
for (let y = SOUTH + 2; y < H; y++) setWall(W - 1, y, 'hedge');
// door thresholds get plain wood
for (const x of hDoors) for (const y of [11, 12]) floor[y][x] = tid('door_floor');
for (const vx of [13, 26]) for (const y of [6, 7]) floor[y][vx] = tid('door_floor');
for (const y of [17, 18]) for (const x of [15, 39, 53]) floor[y][x] = tid('door_floor');
for (const x of sDoors) for (const y of [SOUTH, SOUTH + 1]) floor[y][x] = tid('door_floor');
for (const y of [31, 32]) floor[y][15] = tid('door_floor');
// garden paths: one along the middle, one from each door down to it, one to the Orangery
{
  const path = (x, y) => { floor[y][x] = tid(`path_${hash(x, y) % 2}`); };
  for (let x = 16; x < W - 1; x++) path(x, 29);
  for (const x of [27, 28, 44, 45, 58, 59]) for (let y = SOUTH + 2; y < 29; y++) path(x, y);
  for (let x = 16; x < 20; x++) for (const y of [31, 32]) path(x, y);
  for (const x of [18, 19]) path(x, 30);
}

// ---- rugs (9-slice into the floor layer) ----
const rug = (color, x0, y0, w, h) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const v = y === y0 ? 'n' : y === y0 + h - 1 ? 's' : '';
    const hz = x === x0 ? 'w' : x === x0 + w - 1 ? 'e' : '';
    floor[y][x] = tid(`rug_${color}_${(v + hz) || 'c'}`);
  }
};
rug('green', 2, 6, 9, 2);
rug('blue', 16, 4, 8, 5);
rug('orange', 28, 5, 9, 3);
rug('red', 3, 15, 9, 5);
rug('teal', 17, 17, 20, 2);
rug('green', 41, 6, 11, 2);
rug('blue', 42, 16, 9, 3);
rug('orange', 55, 6, 8, 4); // music room dance floor
floor[EXIT.y][EXIT.x] = tid('doormat');

// ---- objects: multi-tile furniture. Footprint blocks walking unless walkable. ----
// Wall decor (wall:true) sits on wall faces and never blocks.
const objects = [];
let oid = 0;
const obj = (type, x, y, w = 1, h = 1, extra = {}) => objects.push({ id: `o${++oid}`, type, x, y, w, h, ...extra });
// what clicking an object offers (see ObjectUse in shared/map.ts)
const LAMP = { light: true, use: { kind: 'toggle', label: 'lamp' }, on: true };
const COFFEE = { kind: 'take', items: [{ id: 'coffee', label: 'Coffee', icon: '☕' }, { id: 'tea', label: 'Tea', icon: '🍵' }] };
const FRIDGE = { kind: 'take', items: [{ id: 'snack', label: 'Snack', icon: '🥪' }, { id: 'juice', label: 'Juice', icon: '🧃' }, { id: 'icecream', label: 'Ice cream', icon: '🍦' }] };

// outer windows & wall decor
for (const wx of [3, 9, 29, 36]) obj('window', wx, 1, 2, 2, { wall: true });
obj('whiteboard', 18, 1, 3, 2, { wall: true });
obj('painting', 23, 1, 1, 2, { wall: true });
obj('noticeboard', 2, 12, 2, 1, { wall: true });
obj('clock', 25, 12, 1, 1, { wall: true });
obj('painting_small', 10, 12, 1, 1, { wall: true });

// Focus: desks with monitors, chairs, a lamp, bookshelf
for (const [dx, dy] of [[2, 4], [5, 4], [8, 4], [2, 8], [9, 8]]) {
  obj('desk', dx, dy, 2, 1);
  obj('chair', dx, dy + 1, 1, 1, { walkable: true });
}
obj('bookshelf', 10, 3, 2, 1);
obj('lamp', 12, 3, 1, 1, LAMP);
obj('plant', 1, 3, 1, 1);
obj('lamp', 12, 9, 1, 1, LAMP);

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
obj('sofa', 5, 21, 3, 1, { sit: true, dir: 'down' });
obj('table_round', 6, 19, 1, 1);
obj('reception', 10, 14, 3, 1);
obj('plant', 1, 22, 1, 1);
obj('bookshelf', 12, 21, 2, 1);

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
obj('lamp', 1, 14, 1, 1, LAMP);
obj('lamp', 27, 10, 1, 1, LAMP);
obj('lamp', 14, 10, 1, 1, LAMP);

obj('radio', 58, 4, 1, 1, { sound: { clip: 'radio', gain: 0.8 } }); // on the music room's back wall

// wall calendars: click to see your own Google Calendar (after the radio, same reason)
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
obj('lamp', 52, 17, 1, 1, LAMP);
obj('bookshelf', 47, 22, 2, 1);
// Music room (after the east wing, same reason): windows, tables with stools, sofas along the bottom
for (const wx of [55, 60]) obj('window', wx, 1, 2, 2, { wall: true });
obj('plant', 54, 3, 1, 1);
obj('plant', 63, 3, 1, 1);
for (const tx of [56, 61]) { obj('table_round', tx, 13); obj('stool', tx - 1, 13, 1, 1, { walkable: true }); obj('stool', tx + 1, 13, 1, 1, { walkable: true }); }
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

// ---- walkable mask ----
const walkable = grid(1);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (walls[y][x]) walkable[y][x] = 0;
for (const o of objects) {
  if (o.wall || o.walkable) continue;
  for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) walkable[y][x] = 0;
}

// ---- spots: seats facing their table + a few standing spots ----
const roomOf = (x, y) => rooms.find(r => x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h);
const seatDir = (o) => {
  const free = (x, y) => walkable[y]?.[x] === 1;
  // face the neighbouring blocked furniture
  if (!free(o.x, o.y - 1) && walls[o.y - 1][o.x] === 0) return 'up';
  if (!free(o.x, o.y + 1)) return 'down';
  if (!free(o.x + 1, o.y)) return 'right';
  if (!free(o.x - 1, o.y)) return 'left';
  return 'down';
};
for (const r of rooms) r.spots = [];
for (const o of objects) {
  if (o.sit) { // sofas: every tile is a seat
    const r = roomOf(o.x, o.y);
    for (let x = o.x; x < o.x + o.w; x++) if (r) r.spots.push({ x, y: o.y, dir: o.dir });
    continue;
  }
  if (o.type !== 'chair' && o.type !== 'stool') continue;
  const r = roomOf(o.x, o.y);
  o.dir = seatDir(o);
  if (r) r.spots.push({ x: o.x, y: o.y, dir: o.dir });
}
const stand = (id, list) => rooms.find(r => r.id === id).spots.push(...list.map(([x, y, dir]) => ({ x, y, dir })));
stand('coffee', [[30, 8, 'down'], [31, 8, 'down'], [33, 5, 'up'], [29, 4, 'up'], [37, 7, 'left']]);
stand('lobby', [[4, 17, 'down'], [8, 17, 'down'], [6, 20, 'down'], [11, 15, 'up'], [3, 19, 'right']]);
stand('focus', [[7, 7, 'down']]);
stand('meeting', [[19, 9, 'up'], [24, 8, 'left']]);
stand('cowork', [[25, 17, 'down'], [31, 18, 'down'], [36, 13, 'down']]);
stand('studio', [[46, 7, 'down']]);
stand('desks', [[42, 17, 'right'], [50, 18, 'left']]);
stand('music', [[57, 7, 'up'], [60, 8, 'up'], [58, 10, 'up']]);
stand('orangery', [[7, 27, 'down'], [8, 29, 'down'], [7, 31, 'down']]);
stand('garden', [[42, 29, 'down'], [43, 29, 'down'], [31, 27, 'left'], [56, 28, 'down'], [20, 28, 'down']]);
// where people's plants stand when they have no home desk: the Orangery's shelf tiles, in order
for (const o of objects) if (o.type === 'plant_shelf') for (let x = o.x; x < o.x + o.w; x++) {
  const r = roomOf(x, o.y); (r.plantSlots ??= []).push({ x, y: o.y });
}
if (!walkable[EXIT.y][EXIT.x]) throw new Error('exit not walkable');
for (const r of rooms) for (const s of r.spots) {
  const sofa = objects.find(o => o.sit && s.x >= o.x && s.x < o.x + o.w && s.y >= o.y && s.y < o.y + o.h);
  if (!walkable[s.y][s.x] && !sofa) throw new Error(`spot ${r.id} ${s.x},${s.y} not walkable`);
}

const map = { version: 1, width: W, height: H, tileSize: 16, tiles, layers: { floor, walls, walkable }, rooms, objects, spawn: { x: 7, y: 17 }, exit: EXIT };
const reached = new Set([`${map.spawn.x},${map.spawn.y}`]), queue = [map.spawn];
for (let i = 0; i < queue.length; i++) for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
  const x = queue[i].x + dx, y = queue[i].y + dy, key = `${x},${y}`;
  if (walkable[y]?.[x] === 1 && !reached.has(key)) { reached.add(key); queue.push({ x, y }); }
}
// a sofa seat isn't walkable: you sit down onto it from the tile in front, so that tile must be reachable
const FRONT = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
const reachable = (t) => {
  const sofa = objects.find(o => o.sit && t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h);
  const [dx, dy] = sofa ? FRONT[sofa.dir] : [0, 0];
  return reached.has(`${t.x + dx},${t.y + dy}`);
};
for (const t of [map.spawn, EXIT, ...rooms.flatMap(r => r.spots)]) if (!reachable(t)) throw new Error(`unreachable tile ${t.x},${t.y}`);
writeFileSync(new URL('../shared/tilemap.json', import.meta.url), JSON.stringify(map));
console.log(`tilemap: ${W}x${H}, ${tiles.length - 1} tile kinds, ${objects.length} objects, ${rooms.reduce((n, r) => n + r.spots.length, 0)} spots`);
