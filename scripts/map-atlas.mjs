// Writes docs/MAP.md from shared/tilemap.json: floor plans, rooms, every usable object, and free space for new things.
// Run: npm run gen (after gen-map). Generated: don't hand-edit docs/MAP.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { applyLayout, besideObject, roomAt, USE_KINDS } from '../shared/map.ts';

const map = JSON.parse(readFileSync(new URL('../shared/tilemap.json', import.meta.url), 'utf8'));
applyLayout(map, { objects: map.objects, rugs: map.rugs }); // the JSON's walkable layer is already this; rebuilds the index
const { width: W, office } = map, H = office.h;
const tileName = (x, y) => map.tiles[map.layers.floor[y][x]] ?? '';
const wallName = (x, y) => map.tiles[map.layers.walls[y][x]] ?? '';
const walkable = (x, y) => map.layers.walkable[y]?.[x] === 1;
const door = (x, y) => tileName(x, y) === 'door_floor';
const key = (x, y) => `${x},${y}`;

// reachable from the spawn (the office proper), so unused patches stand out
const reached = new Set([key(map.spawn.x, map.spawn.y)]);
for (const q = [map.spawn]; q.length;) {
  const { x, y } = q.shift();
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const nx = x + dx, ny = y + dy;
    if (walkable(nx, ny) && !reached.has(key(nx, ny))) { reached.add(key(nx, ny)); q.push({ x: nx, y: ny }); }
  }
}

// room letters: A, B, … in tilemap order (later rooms win their tiles, like roomAt)
const letter = new Map(map.rooms.map((r, i) => [r.id, String.fromCharCode(65 + i)]));
const objAt = new Map(); // floor objects by tile; wall decor separately
const wallObjAt = new Map();
for (const o of map.objects) for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
  const m = o.wall ? wallObjAt : objAt;
  if (!m.has(key(x, y)) || o.onTop) m.set(key(x, y), o);
}
const spots = new Set(map.rooms.flatMap(r => r.spots.map(s => key(s.x, s.y))));
const special = new Map([[key(map.spawn.x, map.spawn.y), '@'], [key(map.exit.x, map.exit.y), 'x']]);
if (map.dungeon) for (const k of ['hole', 'hatch']) special.set(key(map.dungeon[k].x, map.dungeon[k].y), k === 'hole' ? '0' : 'H');
// each room's id written across the middle of its rect (where it fits), on the rooms plan
// (the longest run of the room's own tiles, nearest the middle row, so the Terrace doesn't cut into the Garden's label)
const label = new Map();
for (const r of map.rooms) {
  const mid = r.rect.y + Math.floor((r.rect.h - 1) / 2);
  const rows = [...Array(r.rect.h).keys()].map(i => r.rect.y + i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  for (const y of rows) {
    let best = null;
    for (let x = r.rect.x; x < r.rect.x + r.rect.w;) {
      if (roomAt(map, x, y) !== r || special.has(key(x, y))) { x++; continue; }
      let n = 0; while (x + n < r.rect.x + r.rect.w && roomAt(map, x + n, y) === r && !special.has(key(x + n, y))) n++;
      if (!best || n > best.n) best = { x, n };
      x += n;
    }
    if (best && best.n >= r.id.length) {
      const x0 = best.x + Math.floor((best.n - r.id.length) / 2);
      [...r.id].forEach((c, i) => label.set(key(x0 + i, y), c));
      break;
    }
  }
}
/** The room an object belongs to: wall decor hangs on the wall face above a room's floor. */
const roomOf = o => { if (!o.wall) return roomAt(map, o.x, o.y); for (let y = o.y + o.h; y <= o.y + o.h + 2; y++) { const r = roomAt(map, o.x, y); if (r) return r; } };

const ruler = (x0, x1) => {
  let tens = '    ', ones = '    ';
  for (let x = x0; x < x1; x++) { tens += x % 10 === 0 ? String(x / 10 % 10) : ' '; ones += String(x % 10); }
  return [tens, ones];
};
const plan = (cell, y0 = 0, y1 = H, x0 = 0, x1 = W) => {
  const out = ruler(x0, x1);
  for (let y = y0; y < y1; y++) {
    let row = String(y).padStart(3) + ' ';
    for (let x = x0; x < x1; x++) row += cell(x, y);
    out.push(row);
  }
  return out.join('\n');
};

const wallChar = (x, y) => (wallName(x, y) === 'hedge' ? '%' : /^(rock$|cliff$|sea$|mtn_)/.test(wallName(x, y)) ? '^' : '#');
// * already marks usable furniture; H frees = (previously the hatch) for pier planks.
const terrainChar = (x, y) => /^water_/.test(tileName(x, y)) ? '~' : tileName(x, y) === 'pier' ? '=' : /^(trail|snow)_/.test(tileName(x, y)) ? ':' : /^sand_/.test(tileName(x, y)) ? '.' : null;
const roomsPlan = plan((x, y) => {
  if (special.has(key(x, y))) return special.get(key(x, y));
  if (door(x, y) && !map.layers.walls[y][x]) return '+';
  if (map.layers.walls[y][x]) return wallChar(x, y);
  if (label.has(key(x, y))) return label.get(key(x, y));
  const terrain = terrainChar(x, y); if (terrain) return terrain;
  const r = roomAt(map, x, y);
  return r ? letter.get(r.id) : reached.has(key(x, y)) ? '.' : ',';
});
const furniturePlan = plan((x, y) => {
  if (special.has(key(x, y))) return special.get(key(x, y));
  if (door(x, y) && !map.layers.walls[y][x]) return '+';
  const wo = wallObjAt.get(key(x, y));
  if (map.layers.walls[y][x]) return wo?.use ? '*' : wallChar(x, y);
  const o = objAt.get(key(x, y));
  if (o?.use) return '*';
  if (o && (o.type === 'chair' || o.type === 'stool' || o.sit || o.lie)) return 'h';
  if (o && !o.walkable) return 'X';
  if (o) return 'w'; // walkable furniture (dance floor)
  if (spots.has(key(x, y))) return 's';
  return terrainChar(x, y) ?? (reached.has(key(x, y)) ? '.' : ',');
});

// ---- free space: the largest empty rectangles in each room (no furniture, seats, spots, doorways or the tiles in front of them) ----
const blocked = new Set();
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!walkable(x, y) || !reached.has(key(x, y)) || objAt.has(key(x, y)) || spots.has(key(x, y)) || special.has(key(x, y))) blocked.add(key(x, y));
  if (door(x, y)) for (const [dx, dy] of [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]]) blocked.add(key(x + dx, y + dy));
}
for (const o of map.objects) if (o.use) for (const t of besideObject(map, o)) blocked.add(key(t.x, t.y)); // keep usable things usable
for (const o of map.objects) if (o.sit || o.lie) {
  const xs = o.lie ? [o.x + Math.floor((o.w - 1) / 2)] : Array.from({ length: o.w }, (_, i) => o.x + i);
  const step = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] }[o.dir ?? 'down'];
  for (const x of xs) blocked.add(key(x + step[0], o.y + step[1]));
}
const rugAt = (x, y) => map.rugs.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
const freeRects = (room) => {
  const { x: rx, y: ry, w: rw, h: rh } = room.rect, taken = new Set(), out = [];
  const free = (x, y) => !blocked.has(key(x, y)) && !taken.has(key(x, y)) && roomAt(map, x, y) === room;
  for (;;) {
    let best = null;
    for (let y0 = ry; y0 < ry + rh; y0++) for (let x0 = rx; x0 < rx + rw; x0++) {
      if (!free(x0, y0)) continue;
      let maxW = rw;
      for (let y1 = y0; y1 < ry + rh && free(x0, y1); y1++) {
        let w = 0; while (w < maxW && x0 + w < rx + rw && free(x0 + w, y1)) w++;
        maxW = w; const h = y1 - y0 + 1;
        if (w >= 2 && h >= 2 && (!best || w * h > best.w * best.h)) best = { x: x0, y: y0, w, h };
      }
    }
    if (!best || best.w * best.h < 4) return out;
    out.push(best);
    for (let y = best.y; y < best.y + best.h; y++) for (let x = best.x; x < best.x + best.w; x++) taken.add(key(x, y));
  }
};

// ---- unused grid space: unreachable floor inside the office, and void rows outside it ----
const patches = [];
{
  const seen = new Set();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (map.layers.walls[y][x] || reached.has(key(x, y)) || seen.has(key(x, y)) || !map.layers.floor[y][x]) continue;
    let x0 = x, y0 = y, x1 = x, y1 = y, n = 0; // n: tiles with no furniture on them (a patch that's all furniture is just furniture)
    for (const q = [[x, y]]; q.length;) {
      const [cx, cy] = q.pop(); if (seen.has(key(cx, cy))) continue; seen.add(key(cx, cy)); if (!objAt.has(key(cx, cy))) n++;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && !map.layers.walls[ny][nx] && !reached.has(key(nx, ny)) && map.layers.floor[ny][nx]) q.push([nx, ny]);
      }
    }
    patches.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n });
  }
}

const rect = r => `${r.x},${r.y} ${r.w}×${r.h}`;
const tableRow = cells => `| ${cells.join(' | ')} |`;
const flags = k => Object.keys(USE_KINDS[k]).join(' ') || '—';
const lines = [];
const p = (...xs) => lines.push(...xs);
p('# The Deck: map atlas',
  '',
  '<!-- Generated by scripts/map-atlas.mjs from shared/tilemap.json (npm run gen). Do not edit by hand. -->',
  '',
  `Grid ${map.width}×${map.height} tiles of ${map.tileSize}px. Office: ${rect(office)} (camera, overview and edit mode stay inside it).` +
  (map.dungeon ? ` Dungeon: ${rect(map.dungeon.rect)}, not connected to the office.` : ''),
  `Spawn ${key(map.spawn.x, map.spawn.y)}, exit ${key(map.exit.x, map.exit.y)}` +
  (map.dungeon ? `, garden hole ${key(map.dungeon.hole.x, map.dungeon.hole.y)}, hatch ${key(map.dungeon.hatch.x, map.dungeon.hatch.y)}.` : '.'),
  `Coordinates are tile x,y (x right, y down). Object ids are positional (o1…o${map.objects.length}): append new objects at the end of gen-map.mjs so saved layouts keep their ids.`,
  '',
  'Look things up from the shell: `npm run where -- <roomId|objectType|useKind|objectId|x,y>`.',
  '',
  '## Rooms plan',
  '',
  'Each room is filled with its letter (table below) and labelled with its id. `#` wall, `%` hedge, `+` doorway,',
  '`.` walkable outside any room, `,` floor nobody can reach, `@` spawn, `x` exit, `0` garden hole (into the dungeon), `H` hatch. Terrain: `~` water, `^` rock/cliff/sea, `=` pier, `:` trail/snow, `.` sand (room labels take precedence).',
  '',
  '```', roomsPlan, '```',
  '',
  '## Furniture plan',
  '',
  '`*` usable object (has `use`, wall or floor), `X` furniture that blocks walking, `h` seat (chair, stool, sofa, bench),',
  '`w` walkable furniture (dance floor), `s` standing spot, `.` free floor, `,` unreachable floor; `#` `%` `+` `@` `x` `0` `H` `~` `^` `=` `:` as above.',
  '',
  '```', furniturePlan, '```',
  '',
  ...(map.dungeon ? ['## Dungeon', '',
    'A maze under the garden, not connected to the office: you fall in through the hole (`0` above), only from your own `move`.',
    '`#` wall, `.` floor, `L` landing, `D` door (locked until you have the key), `d` in front of it, `k` key spot, `t` torch.', '',
    '```', plan((x, y) => {
      const d = map.dungeon, at = t => t.x === x && t.y === y;
      if (at(d.landing)) return 'L';
      if (x >= d.door.x && x < d.door.x + d.door.w && y >= d.door.y && y < d.door.y + d.door.h) return 'D';
      if (at(d.doorFront)) return 'd';
      if (d.keySpots.some(at)) return 'k';
      if (d.torches.some(at)) return 't';
      return map.layers.walls[y][x] ? '#' : '.';
    }, map.dungeon.rect.y, map.dungeon.rect.y + map.dungeon.rect.h, map.dungeon.rect.x, map.dungeon.rect.x + map.dungeon.rect.w), '```', ''] : []),
  '## Rooms',
  '',
  tableRow(['', 'id', 'name', 'type', 'rect (x,y w×h)', 'cap', 'knock', 'voice', 'access', 'homeDesks', 'seats', 'label']),
  tableRow(Array(12).fill('---')),
  ...map.rooms.map(r => tableRow([letter.get(r.id), `\`${r.id}\``, r.name, r.type, rect(r.rect), r.capacity, r.rules.knock, r.rules.voice ?? '', r.rules.access ?? '',
    r.homeDesks ? 'yes' : '', r.spots.length, r.rules.label ?? ''])),
  '',
  'Rooms are data (`rooms` in scripts/gen-map.mjs): knock rules, voice, access and meeting links are read from here, not code.',
  'A room listed later wins the tiles it shares with an earlier one (the Terrace sits inside the Garden).',
  '',
  '## Usable objects',
  '',
  'Every object with a `use` (wall decor counts toward the room below it). Routing flags come from `USE_KINDS` in shared/map.ts: `wheel` opens the action wheel,',
  '`use` goes through the server\'s generic `use` intent, `reach` must stay reachable in any layout. No flag: App.tsx `e.onPick` handles the click directly.',
  '',
  tableRow(['id', 'type', 'kind', 'routing', 'x,y', 'w×h', 'room', 'label / details']),
  tableRow(Array(8).fill('---')),
  ...map.objects.filter(o => o.use).map(o => {
    const u = o.use, details = u.kind === 'take' ? u.items.map(i => i.id).join(', ') : u.kind === 'dealer' ? u.items.join(', ')
      : u.kind === 'instrument' ? u.instrument : u.kind === 'clock' ? u.tz : u.kind === 'link' ? u.url : '';
    return tableRow([o.id, `\`${o.type}\``, `\`${u.kind}\``, flags(u.kind), key(o.x, o.y), `${o.w}×${o.h}`,
      roomOf(o)?.id ?? '', [u.label, details].filter(Boolean).join(' · ') + (o.wall ? ' (on a wall)' : '')]);
  }),
  '',
  'Kinds with no object on the map yet: ' + (Object.keys(USE_KINDS).filter(k => !map.objects.some(o => o.use?.kind === k)).map(k => `\`${k}\``).join(', ') || 'none') + '.',
  '',
  '## What else is in each room',
  '',
  tableRow(['room', 'objects (type ×count)']),
  tableRow(['---', '---']),
  ...[...map.rooms, { id: '(none)', rect: null }].map(r => {
    const counts = new Map();
    for (const o of map.objects) if ((roomOf(o)?.id ?? '(none)') === r.id) counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
    return counts.size ? tableRow([`\`${r.id}\``, [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ')]) : null;
  }).filter(Boolean),
  '',
  '## Free space',
  '',
  'Largest empty rectangles of reachable floor per room, biggest first: no furniture, seats or standing spots, and clear of',
  'doorways, the tiles in front of sofas and the tiles beside usable objects. Rugs may lie there (a rug never blocks).',
  'A 3×3 feature fits where both sides are ≥ 3. `layoutProblem` (shared/map.ts) has the final word: gen-map.mjs throws if a layout breaks a rule.',
  '',
  tableRow(['room', 'free rects (x,y w×h)']),
  tableRow(['---', '---']),
  ...map.rooms.map(r => {
    const rs = freeRects(r);
    return tableRow([`\`${r.id}\``, rs.length ? rs.slice(0, 6).map(f => `${rect(f)}${rugAt(f.x, f.y) ? ' (rug)' : ''}`).join(' · ') + (rs.length > 6 ? ` · +${rs.length - 6} smaller` : '') : 'none']);
  }),
  '',
  '### Room for a new room',
  '',
  ...patches.filter(pt => pt.n >= 4).map(pt => `- Unused floor inside the office at ${rect(pt)} (${pt.n} free tiles, ${roomAt(map, pt.x, pt.y)?.id ? `inside \`${roomAt(map, pt.x, pt.y).id}\`` : 'in no room'}): nobody can walk there yet. A room there needs a \`rooms\` entry and a doorway (a gap in the wall or hedge, floored with \`door_floor\`).`),
  `- Rows ${office.y + office.h}..${map.height - 1} are outside the office (void${map.dungeon ? `, except the dungeon at ${rect(map.dungeon.rect)}` : ''}). A new wing there means growing \`OFFICE_H\` (and \`H\`) in gen-map.mjs and moving \`dungeonRect\` down.`,
  '- Making the grid wider means growing `W` in gen-map.mjs; the east edge (x ' + (W - 1) + ') is the outer wall.',
  '',
);
writeFileSync(new URL('../docs/MAP.md', import.meta.url), lines.join('\n'));
console.log(`atlas: docs/MAP.md (${map.rooms.length} rooms, ${map.objects.filter(o => o.use).length} usable objects)`);
