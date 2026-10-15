// Where is something on the map, and which files deal with it?
//   npm run where -- bell          a use.kind, object type, room id/name, object id (o224) or tile (11,14)
//   npm run where -- bell --word   also match the bare word in code, not just 'bell' / "bell"
// Reads shared/tilemap.json (the generated layout, not an admin's saved one) and greps the sources with git grep.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { applyLayout, roomAt, seatAt, USE_KINDS } from '../shared/map.ts';

const args = process.argv.slice(2), word = args.includes('--word'), q = args.find(a => !a.startsWith('--'));
if (!q) { console.log('usage: npm run where -- <useKind|objectType|roomId|objectId|x,y> [--word]'); process.exit(1); }
const map = JSON.parse(readFileSync(new URL('../shared/tilemap.json', import.meta.url), 'utf8'));
applyLayout(map, { objects: map.objects, rugs: map.rugs });
const roomOf = o => { if (!o.wall) return roomAt(map, o.x, o.y); for (let y = o.y + o.h; y <= o.y + o.h + 2; y++) { const r = roomAt(map, o.x, y); if (r) return r; } };
const flags = k => Object.keys(USE_KINDS[k] ?? {}).join(' ') || 'none (App.tsx e.onPick acts on the click)';
const show = o => `  ${o.id.padEnd(5)} ${o.type.padEnd(15)} at ${o.x},${o.y} ${o.w}×${o.h}${o.wall ? ' (wall)' : ''}  room: ${roomOf(o)?.id ?? '-'}` +
  (o.use ? `  use: ${o.use.kind}${o.use.label ? ` "${o.use.label}"` : ''}` : '') + (o.walkable ? '  walkable' : '') + (o.sit ? '  seat' : '');
const lower = q.toLowerCase(), esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let found = false;
const section = (title, lines) => { if (!lines.length) return; found = true; console.log(`\n${title}`); for (const l of lines) console.log(l); };

const tile = /^(\d+),(\d+)$/.exec(q);
if (tile) {
  const x = +tile[1], y = +tile[2], r = roomAt(map, x, y), seat = seatAt(map, x, y);
  const covering = map.objects.filter(o => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
  const spot = map.rooms.flatMap(r => r.stand).find(s => s.x === x && s.y === y);
  section(`tile ${x},${y}`, [
    `  room: ${r?.id ?? '-'}   floor: ${map.tiles[map.layers.floor[y]?.[x]] || '-'}   wall: ${map.tiles[map.layers.walls[y]?.[x]] || '-'}   walkable: ${map.layers.walkable[y]?.[x] === 1}`,
    ...(seat ? [`  seat facing ${seat.dir}${seat.homeDesk ? ' (home desk room)' : ''}`] : []),
    ...(spot ? [`  standing spot facing ${spot.dir}`] : []),
    ...covering.map(show),
  ]);
}
if (USE_KINDS[q]) {
  section(`use.kind '${q}'  routing: ${flags(q)}`, map.objects.filter(o => o.use?.kind === q).map(show));
  // the places docs/ADDING-A-FEATURE.md says a kind is wired; ✗ = not mentioned there (fine only if the note says so)
  const src = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const has = (f, re) => re.test(src(f));
  const k = esc(q), r = USE_KINDS[q];
  const frames = Object.keys(JSON.parse(src('client/public/assets/atlas.json')).frames);
  const types = [...new Set(map.objects.filter(o => o.use?.kind === q).map(o => o.type))];
  const checks = [
    ['shared/map.ts ObjectUse union', has('shared/map.ts', new RegExp(`kind: '${k}'`)), ''],
    ['scripts/gen-map.mjs places one', types.length > 0, ''],
    [r.wheel ? 'client/src/App.tsx ActionWheel branch' : 'client/src/App.tsx e.onPick line', has('client/src/App.tsx', new RegExp(`kind === '${k}'`)), ''],
    ['server/src/world.ts handles it', has('server/src/world.ts', new RegExp(`kind (===|!==) '${k}'`)), r.use ? 'via World.use' : 'only if it has server state'],
    ['client/src/engine.ts hover tooltip', has('client/src/engine.ts', new RegExp(`kind === '${k}'`)), 'else the tooltip is objectName(type)'],
    ...types.map(t => [`atlas frame '${t}'`, frames.includes(t), 'add it in scripts/gen-assets.mjs, unless engine.ts draws it itself']),
  ];
  section('wiring', checks.map(([what, ok, note]) => `  ${ok ? '✓' : '✗'} ${what}${note && !ok ? `  (${note})` : ''}`));
}
const ofType = map.objects.filter(o => o.type === q);
if (ofType.length) section(`object type '${q}' (${ofType.length})`, ofType.map(show));
const byId = map.objects.find(o => o.id === q) ?? map.rugs.find(r => r.id === q);
if (byId) section(`id ${q}`, ['type' in byId ? show(byId) : `  rug ${byId.color} at ${byId.x},${byId.y} ${byId.w}×${byId.h}`]);
const room = map.rooms.find(r => r.id === lower || r.name.toLowerCase() === lower);
if (room) {
  const inside = map.objects.filter(o => roomOf(o) === room);
  section(`room '${room.id}' (${room.name})`, [
    `  rect ${room.rect.x},${room.rect.y} ${room.rect.w}×${room.rect.h} (x ${room.rect.x}-${room.rect.x + room.rect.w - 1}, y ${room.rect.y}-${room.rect.y + room.rect.h - 1})  capacity ${room.capacity}`,
    `  rules ${JSON.stringify(room.rules)}${room.homeDesks ? '  homeDesks' : ''}  seats+spots ${room.spots.length}`,
    ...inside.filter(o => o.use).map(show),
    `  other objects: ${[...new Set(inside.filter(o => !o.use).map(o => o.type))].join(', ') || '-'}`,
  ]);
}
const like = [...new Set(map.objects.map(o => o.type))].filter(t => t !== q && t.includes(lower));
if (like.length) section('similar object types', [`  ${like.join(', ')}`]);

// ---- code references ----
const grep = patterns => {
  try {
    return execFileSync('git', ['grep', '-n', '-I', '--full-name', ...patterns.flatMap(p => ['-e', p]), '--',
      'shared', 'server/src', 'client/src', 'scripts', 'macos', ':!shared/tilemap.json', ':!shared/music.json', ':!scripts/music.json'],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, maxBuffer: 1 << 26 }).trim().split('\n').filter(Boolean);
  } catch { return []; }
};

let hits = tile ? [] : grep(word ? [`\\b${esc(q)}\\b`] : [`'${esc(q)}'`, `"${esc(q)}"`, `\\bkind === '${esc(q)}'`]);
if (!tile && !hits.length && !word) { hits = grep([`\\b${esc(q)}\\b`]); if (hits.length) console.log(`\n(no quoted '${q}' in code; matching the bare word)`); }
if (hits.length) {
  found = true;
  const byFile = new Map();
  for (const h of hits) { const [file, line, ...rest] = h.split(':'); (byFile.get(file) ?? byFile.set(file, []).get(file)).push(`${line}: ${rest.join(':').trim()}`); }
  console.log(`\ncode (${hits.length} lines in ${byFile.size} files)`);
  for (const [file, lines] of byFile) {
    console.log(`  ${file} (${lines.length})`);
    for (const l of lines.slice(0, 6)) console.log(`    ${l.length > 150 ? `${l.slice(0, 147)}...` : l}`);
    if (lines.length > 6) console.log(`    … ${lines.length - 6} more`);
  }
}
if (!found) console.log(`nothing called '${q}' on the map or in the code`);
