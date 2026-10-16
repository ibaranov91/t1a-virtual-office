import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BAT_RESPAWN_MS, CLEAN_MS, STALL_CLEAN_MS, CUP_LINGER_MS, CUP_TTL_MS, PET_FOLLOW_MS, PET_MS, Creatures, flightPath } from './creatures';
import { World } from './world';
import { isWalkable, stallDoor, type TileMap, type Tile } from '../../shared/map';
import { MAX_CUPS, type ServerMsg } from '../../shared/protocol';
import { PHRASES } from '../../shared/phrases';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const tables = map.objects.filter(o => ['table_big', 'table_round', 'table_long', 'desk'].includes(o.type));
const tableTiles = tables.flatMap(o => Array.from({ length: o.w * o.h }, (_, i) => ({ x: o.x + (i % o.w), y: o.y + Math.floor(i / o.w) })));

function setup() {
  const sent: ServerMsg[] = [];
  const c = new Creatures({ map: () => map, broadcast: m => sent.push(m), people: () => [] });
  return { c, sent };
}

test('the cat walks to a drunk visitor, sits facing them and judges only after arriving', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const w = new World(structuredClone(map)), u = w.addUser('Tipsy guest', false, { x: 34, y: 8 });
  u.presence = 'online'; w.connect(u.id, () => {}); w.addEffect(u, 'drunk');
  const cat = w.creatures.add('cat', 'Biscuit', { x: 30, y: 8 });
  cat.pose = 'nap'; cat.until = Date.now() + 90_000;
  w.creatures.tick(Date.now());
  assert.ok(cat.walk, 'even a nap cannot hide a drunk visitor from this cat');
  assert.equal(cat.say, undefined, 'no lecture across the room');
  const end = cat.walk!.path.at(-1)!;
  assert.equal(Math.abs(end.x - u.tile.x) + Math.abs(end.y - u.tile.y), 1);
  for (const tile of cat.walk!.path) assert.ok(isWalkable(w.map, tile.x, tile.y));
  const arrival = cat.walk!.startedAt + (cat.walk!.path.length - 1) * cat.walk!.ms;
  w.creatures.tick(arrival);
  assert.equal(cat.pose, 'sit'); assert.equal(cat.walk, null);
  assert.ok((PHRASES.cat as Record<string, readonly string[]>).judge?.includes(cat.say!));
  const line = cat.say;
  w.creatures.tick(arrival + 1000); assert.equal(cat.say, line, 'the line stays readable');
  w.creatures.tick(arrival + 6000); assert.equal(cat.say, undefined, 'cooldown prevents another lecture');
});

test('the cat cancels its lecture if the visitor sobers up before it arrives', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const w = new World(structuredClone(map)), u = w.addUser('Guest', false, { x: 34, y: 8 });
  u.presence = 'online'; w.addEffect(u, 'drunk');
  const cat = w.creatures.add('cat', 'Biscuit', { x: 30, y: 8 });
  w.creatures.tick(Date.now()); assert.ok(cat.walk);
  const arrival = cat.until;
  w.removeEffect(u, 'drunk'); w.creatures.tick(arrival);
  assert.equal(cat.say, undefined);
});

test('the cat ignores offline, hidden, bot and already expired drunk effects', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const w = new World(structuredClone(map)), cat = w.creatures.add('cat', 'Biscuit', { x: 30, y: 8 });
  cat.pose = 'nap'; cat.until = Date.now() + 90_000;
  for (const kind of ['offline', 'hidden', 'bot', 'expired']) {
    const u = w.addUser(kind, kind === 'bot', { x: 34, y: 8 });
    u.presence = kind === 'offline' ? 'offline' : 'online';
    if (kind === 'hidden') u.instance = 'private';
    w.addEffect(u, 'drunk', {}, kind === 'expired' ? Date.now() - 60_001 : Date.now());
  }
  w.creatures.tick(Date.now());
  assert.equal(cat.walk, null); assert.equal(cat.pose, 'nap'); assert.equal(cat.say, undefined);
});

test('cups only go on tables, one per tile, and never more than MAX_CUPS', () => {
  const { c } = setup();
  assert.equal(typeof c.addCup(map.spawn, 'coffee', 0), 'string'); // the floor isn't a table
  const first = c.addCup(tableTiles[0], 'coffee', 0);
  assert.equal(typeof first, 'object');
  assert.match(String(c.addCup(tableTiles[0], 'tea', 0)), /already/);
  for (const t of tableTiles.slice(1, MAX_CUPS)) assert.equal(typeof c.addCup(t, 'tea', 0), 'object');
  assert.equal(c.cups.length, MAX_CUPS);
  assert.match(String(c.addCup(tableTiles[MAX_CUPS], 'coffee', 0)), /full/);
  assert.equal(c.cups.length, MAX_CUPS);
});

test('cups vanish on their own after a while', () => {
  const { c } = setup();
  c.addCup(tableTiles[0], 'coffee', 0);
  c.tick(CUP_TTL_MS - 1, new Date(2026, 4, 1)); assert.equal(c.cups.length, 1);
  c.tick(CUP_TTL_MS + 1, new Date(2026, 4, 1)); assert.equal(c.cups.length, 0);
});

test('the cleaner walks to a settled cup by a path of walkable tiles, pauses, takes it, and goes home', () => {
  const { c, sent } = setup();
  const home = c.base(), may = new Date(2026, 4, 1);
  const lady = c.add('cleaner', 'Cleaning lady', home);
  const cup = c.addCup(tableTiles[3], 'coffee', 0);
  assert.ok(typeof cup === 'object');
  c.tick(1000, may);
  assert.equal(lady.cleaning, undefined, 'a fresh cup is left alone for a moment (she may roam meanwhile)');
  let now = CUP_LINGER_MS;
  // she may be mid-stroll when the cup settles: let her finish it, then she heads for the cup
  for (let i = 0; !lady.cleaning && i < 20; i++) { now = Math.max(now, lady.until); c.tick(now, may); }
  const walk = lady.walk!;
  assert.ok(walk && lady.cleaning === cup.id, 'off to the cup');
  for (const p of walk.path) assert.ok(isWalkable(map, p.x, p.y), `walkable ${p.x},${p.y}`);
  for (let i = 1; i < walk.path.length; i++) assert.equal(Math.abs(walk.path[i].x - walk.path[i - 1].x) + Math.abs(walk.path[i].y - walk.path[i - 1].y), 1);
  const end = walk.path[walk.path.length - 1];
  assert.equal(Math.abs(end.x - cup.tile.x) + Math.abs(end.y - cup.tile.y), 1, 'stands right by the cup');
  now = walk.startedAt + (walk.path.length - 1) * walk.ms;
  c.tick(now, may);
  assert.equal(lady.pose, 'clean'); assert.equal(c.cups.length, 1, 'the cup stays while she wipes');
  c.tick(now + CLEAN_MS, may);
  assert.equal(c.cups.length, 0);
  assert.ok(sent.some(m => m.t === 'cups' && m.cups.length === 0));
  const back = lady.walk!;
  assert.ok(back && !lady.cleaning, 'and off for a stroll');
  assert.ok(isWalkable(map, back.path.at(-1)!.x, back.path.at(-1)!.y));
});

test('the cleaner gives up on a cup that went before she got there', () => {
  const { c } = setup();
  const lady = c.add('cleaner', 'Cleaning lady', c.base()), may = new Date(2026, 4, 1);
  const cup = c.addCup(tableTiles[0], 'tea', 0);
  assert.ok(typeof cup === 'object');
  c.tick(CUP_LINGER_MS, may);
  const walk = lady.walk!;
  c.removeCup(cup.id);
  c.tick(walk.startedAt + (walk.path.length - 1) * walk.ms, may);
  assert.notEqual(lady.pose, 'clean');
});

test('the bat only stays in October and flies straight over everything', () => {
  const { c } = setup();
  c.add('bat', 'Bat', { x: 20, y: 13 });
  c.tick(0, new Date(2026, 9, 15)); assert.ok(c.list.has('bat'));
  c.tick(60_000, new Date(2026, 10, 1)); assert.ok(!c.list.has('bat'));
  const path = flightPath({ x: 2, y: 3 }, { x: 5, y: 1 });
  assert.equal(path.length, 6); assert.deepEqual(path.at(-1), { x: 5, y: 1 });
});

test('putting a cup down: walk to the table, cup appears, hands empty; creatures never show up as users', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const u = w.addUser('A', false, { x: 32, y: 8 }); u.presence = 'online';
  const msgs: ServerMsg[] = [];
  const { socket } = w.connect(u.id, m => msgs.push(m));
  w.creatures.add('cat', 'Biscuit', { x: 30, y: 8 });
  const round = map.objects.find(o => o.type === 'table_round' && o.x === 30)!;
  const tile: Tile = { x: round.x, y: round.y };
  w.handle(u, { t: 'cup_put', tile }, socket);
  assert.equal(w.creatures.cups.length, 0, 'not holding anything');
  w.setHolding(u, 'coffee');
  w.handle(u, { t: 'cup_put', tile }, socket);
  t.mock.timers.tick(10_000);
  assert.equal(w.creatures.cups.length, 1);
  assert.equal(u.holding, null);
  const state = msgs.find(m => m.t === 'state');
  assert.ok(state && state.t === 'state' && state.users.every(p => p.name !== 'Biscuit'));
  assert.deepEqual(w.dump().cups.map(c => c.tile), [tile]);
});

test('petting: hearts for a moment, then the pet tags along with that person for about a minute', () => {
  const sent: ServerMsg[] = [];
  const person = { x: 30, y: 8 };
  const c = new Creatures({ map: () => map, broadcast: m => sent.push(m), people: () => [person], personTile: () => person });
  const cat = c.add('cat', 'Biscuit', { x: 31, y: 8 });
  c.petBy(cat, 'u1', 1000);
  assert.equal(cat.pose, 'pet');
  assert.ok(sent.some(m => m.t === 'creature' && m.creature.pose === 'pet'));
  c.tick(1000 + PET_MS - 1); assert.equal(cat.pose, 'pet');
  c.tick(1000 + PET_MS); assert.notEqual(cat.pose, 'pet'); assert.ok(cat.follow, 'still following');
  person.x = 34; person.y = 8; // they walk off: the cat goes after them
  c.tick(1000 + PET_MS + 2000);
  assert.ok(cat.walk, 'trots after them');
  const end = cat.walk!.path.at(-1)!;
  assert.ok(Math.max(Math.abs(end.x - 34), Math.abs(end.y - 8)) <= 1);
  c.tick(1000 + PET_FOLLOW_MS + 1); c.tick(1000 + PET_FOLLOW_MS + 5000); assert.equal(cat.follow, undefined, 'back to its own business');
});

test('the bat: a miss darts off, a catch removes it for ten minutes and gives the hat once', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 1_000_000 });
  const w = new World(map);
  const u = w.addUser('A', false, { x: 21, y: 14 }); u.presence = 'online';
  w.connect(u.id, () => {});
  const notes: string[] = [];
  w.connect(w.addUser('B', false, { x: 40, y: 8 }).id, m => { if (m.t === 'notice') notes.push(m.text); });
  const bat = w.creatures.add('bat', 'Bat', { x: 21, y: 13 });
  bat.pose = 'hang'; w.creatures.batAlways = true;
  w.creatures.rng = () => 0.9;
  w.petCreature(u, 'bat');
  assert.ok(w.creatures.list.has('bat'), 'a miss keeps the bat'); assert.ok(bat.walk, 'and sends it flying');
  bat.pose = 'hang'; bat.walk = null; bat.tile = { x: 21, y: 13 };
  w.creatures.rng = () => 0.1;
  t.mock.timers.tick(500); w.petCreature(u, 'bat');
  assert.ok(w.creatures.list.has('bat'), 'one try a second');
  t.mock.timers.tick(1500); w.petCreature(u, 'bat');
  assert.ok(!w.creatures.list.has('bat'), 'caught');
  assert.deepEqual(u.items.filter(i => i === 'hat:bat'), ['hat:bat']);
  assert.ok(u.achievements.batcatcher);
  assert.ok(notes.some(n => /A caught the bat/.test(n)));
  w.creatures.wantBat(Date.now() + 1000); assert.ok(!w.creatures.list.has('bat'), 'away for a while');
  w.creatures.wantBat(Date.now() + BAT_RESPAWN_MS + 1); assert.ok(w.creatures.list.has('bat'), 'and back');
  w.creatures.list.get('bat')!.pose = 'hang';
  t.mock.timers.tick(2000); w.petCreature(u, 'bat');
  assert.equal(u.items.filter(i => i === 'hat:bat').length, 1, 'one hat per person');
});

test('petting both the cat and the dog in a day makes a whisperer', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 1_000_000 });
  const w = new World(map);
  const u = w.addUser('A', false, { x: 30, y: 8 }); u.presence = 'online';
  w.connect(u.id, () => {});
  w.creatures.add('cat', 'Biscuit', { x: 31, y: 8 }); w.creatures.add('dog', 'Pixel', { x: 29, y: 8 });
  w.petCreature(u, 'cat'); assert.equal(w.creatures.list.get('cat')!.pose, 'pet');
  assert.ok(!u.achievements.whisperer);
  w.petCreature(u, 'dog');
  assert.ok(u.achievements.whisperer);
  w.petCreature(u, 'cleaner'); // not a pet: ignored
});

test('the cleaner scrubs an out-of-order toilet stall and puts it back in order', () => {
  const stall = map.objects.find(o => o.use?.kind === 'toilet')!, door = stallDoor(stall), may = new Date(2026, 4, 1);
  let dirty = true;
  const cleaned: string[] = [];
  const c = new Creatures({ map: () => map, broadcast: () => {}, people: () => [],
    fullStalls: () => dirty ? [{ id: stall.id, door }] : [], cleanStall: id => { cleaned.push(id); dirty = false; } });
  const lady = c.add('cleaner', 'Cleaning lady', c.base());
  let now = 0;
  for (let i = 0; !lady.cleaning && i < 20; i++) { now = Math.max(now, lady.until); c.tick(now, may); }
  assert.equal(lady.cleaning, `stall:${stall.id}`);
  const walk = lady.walk!, end = walk.path[walk.path.length - 1];
  assert.deepEqual(end, door, 'stands at the stall door');
  now = walk.startedAt + (walk.path.length - 1) * walk.ms;
  c.tick(now, may);
  assert.equal(lady.pose, 'clean'); assert.deepEqual(cleaned, [], 'still dirty while she scrubs');
  c.tick(now + STALL_CLEAN_MS, may);
  assert.deepEqual(cleaned, [stall.id]);
});
