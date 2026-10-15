// Generates shared/tilemap.json — the single source of truth for the floor.
// Layers are 2D arrays of indices into `tiles` (atlas frame names); 0 = nothing.
// Run: node scripts/gen-map.mjs
import { writeFileSync } from 'node:fs';

const W = 40, H = 24;
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
    rules: { knock: 'disabled', label: 'quiet — no knocking' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'meeting', name: 'Meeting', type: 'meeting', rect: { x: 14, y: 3, w: 12, h: 8 }, capacity: 8,
    floor: 'wood', rug: 'blue',
    rules: { knock: 'later', occupantLabel: 'in a meeting', label: 'knocks go to Later' },
    meeting: { provider: 'teams', url: 'https://teams.microsoft.com/l/meeting/new' } },
  { id: 'coffee', name: 'Coffee', type: 'coffee', rect: { x: 27, y: 3, w: 12, h: 8 }, capacity: 10,
    floor: 'tile_check', rug: 'orange',
    rules: { voice: 'open', knock: 'allow', label: 'open voice — walk in to talk' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'lobby', name: 'Lobby', type: 'lobby', rect: { x: 1, y: 13, w: 14, h: 10 }, capacity: 30,
    floor: 'wood', rug: 'red',
    rules: { knock: 'allow', label: 'say hi' },
    meeting: { provider: 'meet', url: 'https://meet.google.com/new' } },
  { id: 'cowork', name: 'Co-working', type: 'cowork', rect: { x: 16, y: 13, w: 23, h: 10 }, capacity: 16,
    floor: 'wood', rug: 'teal', homeDesks: true,
    rules: { knock: 'allow', label: 'open mic' },
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
const hDoors = [6, 7, 19, 20, 32, 33];
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
// door thresholds get plain wood
for (const x of hDoors) for (const y of [11, 12]) floor[y][x] = tid('door_floor');
for (const vx of [13, 26]) for (const y of [6, 7]) floor[y][vx] = tid('door_floor');
for (const y of [17, 18]) floor[y][15] = tid('door_floor');

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

obj('radio', 13, 14, 1, 1, { sound: { clip: 'radio', gain: 0.8 } });

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
