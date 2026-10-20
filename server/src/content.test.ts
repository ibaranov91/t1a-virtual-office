import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, SEW_MS, type User } from './world';
import { CUP_LINGER_MS, Creatures, MAX_TOYS } from './creatures';
import { isWalkable, type Tile, type TileMap } from '../../shared/map';
import { ACHIEVEMENTS, MAX_CUPS, type ClientMsg, type Cup, type ServerMsg } from '../../shared/protocol';
import { ENERGY_FACTOR, ACHIEVEMENT_HATS, GACHA_HATS, effectOf, hatItem, walkMs } from '../../shared/effects';
import { ITEM_DEFS, POSTCARD_MAX, isToy, itemDef, postcardOf, postcardText } from '../../shared/items';
import { DRINKS } from '../../shared/drinks';
import { GACHA_ODDS, STICKERS, rollGacha, stickerItem } from '../../shared/gacha';
import { SPAWNS_PER_DAY, SPAWN_BY, SPAWN_ITEMS, planSpawns, seeded } from '../../shared/spawns';
import { HAT_REWARDS, hatChoices, picksDue } from '../../shared/rewards';
import { officeDay, officeMinutes } from '../../shared/officeTime';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const DESK: Tile = { x: 32, y: 12 };
const ROW: Tile = { x: 30, y: 13 }; // a corridor with free floor to the right

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 1_700_000_000_000 });
  const w = new World(map);
  const add = (name: string, tile: Tile = DESK) => {
    const u = w.addUser(name, false, tile); u.presence = 'online';
    const messages: ServerMsg[] = [];
    return { u, messages, ...w.connect(u.id, m => messages.push(m)) };
  };
  const notices = (m: ServerMsg[]) => m.flatMap(x => (x.t === 'notice' ? [x.text] : []));
  return { w, add, notices, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const last = <T extends ServerMsg['t']>(m: ServerMsg[], type: T) => m.filter((x): x is Extract<ServerMsg, { t: T }> => x.t === type).at(-1);
const send = (w: World, p: { u: User; socket: string }, msg: ClientMsg) => w.handle(p.u, msg, p.socket);
const has = (u: User, kind: string) => !!effectOf(u.effects, kind);

test('officeTime: the day and minutes follow Berlin, not the machine', () => {
  const winter = Date.UTC(2026, 0, 15, 23, 30), summer = Date.UTC(2026, 6, 15, 22, 30);
  assert.equal(officeDay(winter), '2026-01-16'); // 00:30 CET
  assert.equal(officeMinutes(winter), 30);
  assert.equal(officeDay(summer), '2026-07-16'); // 00:30 CEST
  assert.equal(officeDay(Date.UTC(2026, 0, 15, 22, 30)), '2026-01-15');
});

test('registry: the 7/11 goods exist with the right shape', () => {
  for (const id of ['onigiri', 'slurpee', 'energy_drink', 'party_popper', 'glow_stick', 'umbrella', 'postcard', 'bubble_gum']) assert.ok(ITEM_DEFS[id], id);
  assert.ok(ITEM_DEFS.cup_noodles, 'cup noodles come from the places work');
  assert.equal(ITEM_DEFS.glow_stick.light, 3);
  assert.equal(ITEM_DEFS.umbrella.pocket, 'counts');
  assert.ok(DRINKS.slurpee && DRINKS.energy_drink, 'drink-shaped goods sip like drinks');
  assert.ok(['snowball', 'train', 'remote_car', 'sewing_kit'].every(isToy) && !isToy('sewn_hat') && !isToy('drugs'));
});

test('onUse: a party popper sprinkles confetti on everyone within 2 tiles, with a sound for the room', t => {
  const { w, add, notices } = setup(t), a = add('A', DESK), near = add('Near', { x: 34, y: 12 }), far = add('Far', { x: 36, y: 12 }), off = add('Off', { x: 33, y: 12 });
  off.u.presence = 'offline';
  w.setHolding(a.u, 'party_popper');
  send(w, a, { t: 'use_held' });
  assert.ok(has(a.u, 'confetti') && has(near.u, 'confetti'));
  assert.ok(!has(far.u, 'confetti'), '3 tiles is too far');
  assert.ok(!has(off.u, 'confetti'), 'offline people are skipped');
  assert.equal(last(far.messages, 'popper')?.userId, a.u.id, 'everyone hears it');
  assert.equal(a.u.holding, null, 'the popper is used up');
  assert.ok(notices(a.messages).includes('🎉 Pop!'));
  send(w, a, { t: 'use_held' }); // nothing in hand: nothing happens
});

test('onUse: a slurpee gives a short shiver on top of chilled; the shiver ends, chilled stays', t => {
  const { w, add, tick } = setup(t), a = add('A');
  w.setHolding(a.u, 'slurpee');
  send(w, a, { t: 'drink' }); tick(2500);
  assert.ok(has(a.u, 'freeze') && has(a.u, 'chilled'), 'both stack');
  assert.equal(a.u.holding, null);
  tick(7_000); w.effectsTick();
  assert.ok(!has(a.u, 'freeze') && has(a.u, 'chilled'));
});

test('onUse: an energy drink out-runs coffee for 5 minutes, then a short slow crash; coffee does not cancel it', t => {
  const { w, add, tick } = setup(t), a = add('A');
  const normal = walkMs([]);
  w.setHolding(a.u, 'energy_drink');
  send(w, a, { t: 'drink' }); tick(1800);
  const boost = effectOf(a.u.effects, 'speed')!;
  assert.equal(boost.until! - Date.now(), 5 * 60_000);
  assert.ok(walkMs(a.u.effects) < Math.round(normal / ENERGY_FACTOR) + 2, 'faster than coffee');
  assert.ok(walkMs(a.u.effects) < Math.round(normal / 1.6));
  w.setHolding(a.u, 'coffee'); send(w, a, { t: 'drink' }); tick(2500);
  assert.ok(effectOf(a.u.effects, 'speed')!.data?.boost, 'the coffee left the boost alone');
  tick(5 * 60_000); w.effectsTick();
  assert.ok(!has(a.u, 'speed') && has(a.u, 'crash'));
  assert.ok(walkMs(a.u.effects) > normal, 'slower while crashing');
  tick(46_000); w.effectsTick();
  assert.ok(!has(a.u, 'crash'));
});

test('onUse: onigiri is eaten, bubble gum blows a bubble; both used up', t => {
  const { w, add, notices } = setup(t), a = add('A');
  w.setHolding(a.u, 'onigiri'); send(w, a, { t: 'use_held' });
  assert.equal(a.u.holding, null); assert.ok(notices(a.messages).some(n => n.includes('Tasty')));
  a.u.items = ['bubble_gum'];
  send(w, a, { t: 'take_out', item: 'bubble_gum' }); send(w, a, { t: 'use_held' });
  assert.ok(has(a.u, 'bubble') && a.u.holding === null && a.u.items.length === 0);
  w.setHolding(a.u, 'umbrella'); send(w, a, { t: 'use_held' });
  assert.equal(a.u.holding, 'umbrella', 'an umbrella has no Use');
});

test('postcards: the line is cleaned and capped, then thrown into their pockets with the text', t => {
  assert.equal(postcardText('  hello\n\tworld \u0007 '), 'hello world');
  assert.equal(postcardText('   '), null);
  assert.equal(postcardText('x'.repeat(500))!.length, POSTCARD_MAX);
  const { w, add, notices } = setup(t), a = add('Ann Lee', DESK), b = add('B', { x: 35, y: 12 });
  a.u.items = ['postcard'];
  send(w, a, { t: 'take_out', item: 'postcard' });
  send(w, a, { t: 'postcard_write', text: '   ' });
  assert.equal(a.u.holding, 'postcard'); assert.ok(notices(a.messages).includes('Write a line first'));
  send(w, a, { t: 'postcard_write', text: 'See you at the standup' });
  assert.equal(postcardOf(a.u.holding), 'See you at the standup — Ann');
  send(w, a, { t: 'postcard_write', text: 'rewrite' }); // already written: ignored
  assert.equal(postcardOf(a.u.holding), 'See you at the standup — Ann');
  send(w, a, { t: 'give', targetId: b.u.id });
  assert.deepEqual(b.u.items.map(postcardOf), ['See you at the standup — Ann']);
  assert.equal(itemDef(b.u.items[0])?.label, 'Postcard');
  assert.equal(a.u.holding, null);
});

test('gacha: one capsule per person per office day, separate from everything else', t => {
  const { w, add, notices, tick } = setup(t), a = add('A'), b = add('B', { x: 33, y: 12 });
  w.rng = () => 0.5; // a sticker
  w.gachaPull(a.u);
  const got = a.u.items.find(i => i.startsWith('sticker_'))!;
  assert.ok(got && notices(a.messages).some(n => n.includes('Capsule!')));
  w.gachaPull(a.u);
  assert.ok(notices(a.messages).includes('🎰 One capsule a day. Come back tomorrow!'));
  assert.equal(a.u.items.length, 1, 'no second capsule today');
  w.gachaPull(b.u); assert.equal(b.u.items.length, 1, 'someone else still has theirs');
  tick(24 * 3600_000); // the next office day
  w.rng = () => 0.5; w.gachaPull(a.u);
  assert.equal(a.u.items.length, 2);
  assert.notEqual(a.u.items[1], got, 'a sticker you own is not given twice');
  // the dev hook gives a fresh capsule, but only in dev
  const before = a.u.items.length;
  send(w, a, { t: 'dev_gacha' }); assert.equal(a.u.items.length, before, 'not in production');
  w.devTools = true; w.rng = () => 0.5; send(w, a, { t: 'dev_gacha' }); assert.equal(a.u.items.length, before + 1, 'dev: a fresh capsule at once');
});

test('gacha: a toy goes to the pockets, a rare hat is worn; a full bag loses nothing', t => {
  const { w, add } = setup(t), a = add('A');
  let r = 0.1; w.rng = () => r;
  w.gachaPull(a.u);
  assert.ok(a.u.items.length === 1 && isToy(a.u.items[0]), 'a toy');
  a.u.gachaDay = undefined; r = 0.01; w.rng = () => r;
  w.gachaPull(a.u);
  assert.ok(a.u.items.some(i => GACHA_HATS.map(hatItem).includes(i)), 'a gacha-only hat');
  assert.ok(has(a.u, 'hat'), 'and it goes on');
  // everything full: no capsule is spent
  a.u.gachaDay = undefined; a.u.items = Array(6).fill('drugs'); w.setHolding(a.u, 'coffee'); r = 0.1; w.rng = () => r;
  const near = w.creatures.beside(a.u.tile).length;
  w.gachaPull(a.u);
  assert.ok(near === 0 ? a.u.gachaDay === undefined : true);
});

test('gacha odds: ~75% stickers, ~20% toys, ~5% hats; repeats fall through', () => {
  const rng = seeded('odds'), n = 20000, count = { sticker: 0, toy: 0, hat: 0 };
  for (let i = 0; i < n; i++) count[rollGacha(rng, []).kind]++;
  assert.ok(Math.abs(count.hat / n - GACHA_ODDS.hat) < 0.01, `hats ${count.hat / n}`);
  assert.ok(Math.abs(count.toy / n - GACHA_ODDS.toy) < 0.015, `toys ${count.toy / n}`);
  assert.ok(Math.abs(count.sticker / n - 0.75) < 0.02);
  const allHats = GACHA_HATS.map(hatItem), allStickers = STICKERS.map(stickerItem);
  assert.equal(rollGacha(() => 0.01, allHats).kind, 'toy', 'no hat left to win: a toy');
  assert.equal(rollGacha(() => 0.5, allStickers).kind, 'toy', 'every sticker owned: a toy');
  assert.equal(rollGacha(() => 0.5, allStickers.slice(1)).item, allStickers[0], 'the one missing sticker');
});

test('spawns: the day seeds which items appear where, the same every time', () => {
  const tiles = Array.from({ length: 200 }, (_, i) => ({ x: i % 20, y: Math.floor(i / 20) }));
  const a = planSpawns('2026-10-18', tiles), b = planSpawns('2026-10-18', tiles), c = planSpawns('2026-10-19', tiles);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, SPAWNS_PER_DAY);
  assert.equal(new Set(a.map(s => `${s.tile.x},${s.tile.y}`)).size, SPAWNS_PER_DAY, 'one per tile');
  assert.ok(a.every(s => (SPAWN_ITEMS as readonly string[]).includes(s.item)));
  assert.equal(planSpawns('x', tiles.slice(0, 2)).length, 2, 'fewer tiles than spawns is fine');
});

test('daily spawns: scattered once per office day on free floor, swept and replaced at midnight; toys are not litter', t => {
  const { w, tick } = setup(t);
  w.dailySpawns();
  const day1 = w.creatures.cups.filter(c => c.by === SPAWN_BY);
  assert.equal(day1.length, SPAWNS_PER_DAY);
  assert.ok(day1.every(c => isToy(c.item) && c.floor && isWalkable(map, c.tile.x, c.tile.y)));
  w.dailySpawns(); assert.equal(w.creatures.cups.length, SPAWNS_PER_DAY, 'nothing more the same day');
  // a restart on the same day keeps the day
  const w2 = new World(map); w2.load(JSON.parse(JSON.stringify(w.dump())));
  w2.dailySpawns(); assert.equal(w2.creatures.cups.filter(c => c.by === SPAWN_BY).length, SPAWNS_PER_DAY);
  tick(24 * 3600_000); w.dailySpawns();
  const day2 = w.creatures.cups.filter(c => c.by === SPAWN_BY);
  assert.equal(day2.length, SPAWNS_PER_DAY);
  assert.ok(!day2.some(c => day1.some(o => o.id === c.id)), 'yesterday\'s are gone');
});

test('picking up a spawned toy takes it into your hands, then your pockets', t => {
  const { w, add, tick } = setup(t), a = add('A');
  const tile = { x: 33, y: 12 };
  const toy = w.creatures.addCup(tile, 'snowball', Date.now(), { floor: true, by: SPAWN_BY, ttl: 1e9 }) as Cup;
  send(w, a, { t: 'cup_take', cupId: toy.id }); tick(3000);
  assert.equal(a.u.holding, 'snowball');
  assert.equal(w.creatures.cups.length, 0);
});

test('snowball: thrown at someone it lands in their pockets and both get a snow aura for 10 minutes', t => {
  const { w, add } = setup(t), a = add('A'), b = add('B', { x: 35, y: 12 });
  a.u.items = ['snowball'];
  send(w, a, { t: 'take_out', item: 'snowball' }); send(w, a, { t: 'give', targetId: b.u.id });
  assert.deepEqual(b.u.items, ['snowball']);
  for (const p of [a, b]) {
    const snow = effectOf(p.u.effects, 'snow')!;
    assert.ok(snow, p.u.name);
    assert.equal(snow.until! - Date.now(), 10 * 60_000);
  }
});

test('toys on the floor: kept, owned, outside the cup limit, and the cleaner leaves them alone', t => {
  const { w, add } = setup(t), a = add('A');
  w.setHolding(a.u, 'train'); send(w, a, { t: 'drop' });
  const train = w.creatures.cups.find(c => c.item === 'train')!;
  assert.ok(train.floor && train.by === a.u.id && train.ttl! > 12 * 3600_000, 'a long-lived prop with an owner');
  // many cups do not push toys out, nor toys push cups out
  const free = [...Array(MAX_CUPS + 3).keys()].map(i => ({ x: 20 + (i % 10), y: 20 + Math.floor(i / 10) })).filter(p => isWalkable(map, p.x, p.y));
  free.forEach((p, i) => w.creatures.addCup(p, 'coffee', Date.now() + i, { floor: true, by: 'x' }));
  assert.ok(w.creatures.cups.some(c => c.id === train.id), 'the train survived the cup limit');
  // the cleaner never plans a toy
  const c = new Creatures({ map: () => map, broadcast: () => {}, people: () => [] });
  const lady = c.add('cleaner', 'Cleaning lady', c.base());
  c.addCup(train.tile, 'train', 0, { floor: true, by: 'u1', ttl: 1e9 });
  assert.equal(c.planClean(lady.tile, 10 * CUP_LINGER_MS), null);
  c.addCup({ x: train.tile.x + 1, y: train.tile.y }, 'coffee', 0, { floor: true });
  assert.equal(c.planClean(lady.tile, 10 * CUP_LINGER_MS)?.cup.item, 'coffee', 'cups still get tidied');
  // the toy cap drops the oldest put-down toy, but never an uncollected spawn
  const c2 = new Creatures({ map: () => map, broadcast: () => {}, people: () => [] });
  const spawn = c2.addCup({ x: 33, y: 12 }, 'snowball', 0, { floor: true, by: SPAWN_BY }) as Cup;
  for (let i = 0; i < MAX_TOYS + 3; i++) c2.addCup({ x: 40 + (i % 10), y: 30 + Math.floor(i / 10) }, 'train', i + 1, { floor: true, by: 'u1' });
  assert.ok(c2.cups.some(x => x.id === spawn.id));
  assert.ok(c2.cups.filter(x => x.by !== SPAWN_BY).length <= MAX_TOYS);
});

test('sewing: an hour of standing still makes a hand-sewn beanie; walking, dropping the kit or leaving stops it', t => {
  const { w, add, tick } = setup(t), a = add('A');
  w.setHolding(a.u, 'sewing_kit');
  send(w, a, { t: 'use_held' });
  assert.ok(has(a.u, 'sewing'));
  tick(SEW_MS - 1000); assert.ok(has(a.u, 'sewing') && !a.u.items.includes('sewn_hat'));
  tick(1500);
  assert.ok(!has(a.u, 'sewing') && a.u.items.includes('sewn_hat') && a.u.holding === null, 'the kit becomes the hat');
  // stopped by a walk: the hour starts over
  w.setHolding(a.u, 'sewing_kit'); a.u.items = [];
  send(w, a, { t: 'use_held' }); tick(SEW_MS / 2);
  send(w, a, { t: 'move', to: { x: 33, y: 12 } });
  assert.ok(!has(a.u, 'sewing'));
  tick(SEW_MS); assert.ok(!a.u.items.includes('sewn_hat'));
  // put the kit down: it stops too
  send(w, a, { t: 'use_held' }); tick(5_000);
  assert.ok(has(a.u, 'sewing'));
  send(w, a, { t: 'sew_stop' }); assert.ok(!has(a.u, 'sewing'));
  // dev time scale: the hour in a few seconds
  w.devTools = true; send(w, a, { t: 'dev_time', scale: 3600 });
  send(w, a, { t: 'use_held' }); tick(1500);
  assert.ok(a.u.items.includes('sewn_hat'));
  // the beanie can be worn (it becomes a hat), or given away first
  send(w, a, { t: 'take_out', item: 'sewn_hat' }); send(w, a, { t: 'use_held' });
  assert.ok(a.u.items.includes(hatItem('handsewn')) && effectOf(a.u.effects, 'hat')?.data?.style === 'handsewn');
});

test('sewing refuses while walking and a sewn beanie can be thrown to a friend', t => {
  const { w, add, notices } = setup(t), a = add('A', ROW), b = add('B', { x: 35, y: 12 });
  w.setHolding(a.u, 'sewing_kit');
  send(w, a, { t: 'move', to: { x: 36, y: 13 } });
  send(w, a, { t: 'use_held' });
  assert.ok(!has(a.u, 'sewing') && notices(a.messages).includes('Stand still to sew'));
  a.u.items = ['sewn_hat']; w.setHolding(a.u, null);
  a.u.tile = ROW; a.u.move = null;
  send(w, a, { t: 'take_out', item: 'sewn_hat' }); send(w, a, { t: 'give', targetId: b.u.id });
  assert.deepEqual(b.u.items, ['sewn_hat']);
});

test('remote car: put it down and drive with arrow keys or clicks; End ride, and pick it up', t => {
  const { w, add, tick, notices } = setup(t), a = add('A', ROW), b = add('B', { x: 30, y: 14 });
  w.setHolding(a.u, 'remote_car');
  send(w, a, { t: 'use_held' });
  const car = () => w.creatures.cups.find(c => c.item === 'remote_car')!;
  assert.ok(has(a.u, 'driving') && car().by === a.u.id && a.u.holding === null);
  const start = { ...car().tile };
  // arrows: one tile each, rate limited
  let moved: ServerMsg[] = [];
  const b0 = b.messages.length; tick(200);
  send(w, a, { t: 'car_dir', dir: 'right' }); send(w, a, { t: 'car_dir', dir: 'right' });
  moved = b.messages.slice(b0).filter(m => m.t === 'car');
  assert.equal(moved.length, 1, 'the second press came too soon');
  assert.deepEqual(car().tile, { x: start.x + 1, y: start.y });
  assert.equal(car().dir, 'right');
  // a click sends it along a path, a tile per step
  tick(200);
  send(w, a, { t: 'car_go', to: { x: start.x + 4, y: start.y } });
  for (let i = 0; i < 5; i++) tick(130); // a step at a time: the mock clock doesn't chain timers inside one tick
  assert.deepEqual(car().tile, { x: start.x + 4, y: start.y });
  // someone else can't take the controller while it's busy, nor steer it
  send(w, b, { t: 'cup_take', cupId: car().id }); tick(1000);
  assert.ok(!has(b.u, 'driving') && notices(b.messages).includes('Someone is driving that car'));
  send(w, b, { t: 'car_dir', dir: 'left' }); assert.deepEqual(car().tile, { x: start.x + 4, y: start.y });
  // End ride leaves the car on the floor; clicking it takes the controller again
  send(w, a, { t: 'car_end' });
  assert.ok(!has(a.u, 'driving') && w.creatures.cups.some(c => c.item === 'remote_car'));
  send(w, a, { t: 'car_dir', dir: 'left' }); assert.deepEqual(car().tile, { x: start.x + 4, y: start.y }, 'no controller, no steering');
  send(w, a, { t: 'cup_take', cupId: car().id });
  assert.ok(has(a.u, 'driving'));
  send(w, a, { t: 'car_end', pickup: true });
  assert.equal(a.u.holding, 'remote_car'); assert.ok(!w.creatures.cups.some(c => c.item === 'remote_car'));
});

test('remote car: walls stop it, a walk or going offline puts the controller down', t => {
  const { w, add, tick } = setup(t), a = add('A', ROW);
  w.setHolding(a.u, 'remote_car'); send(w, a, { t: 'use_held' });
  const car = () => w.creatures.cups.find(c => c.item === 'remote_car')!;
  const wall = [...Array(40).keys()].map(i => ({ x: 1 + i, y: 1 })).find(p => !isWalkable(map, p.x, p.y))!;
  w.creatures.moveCar(car().id, { x: wall.x, y: wall.y + 1 }, 'down');
  const before = { ...car().tile };
  tick(200); send(w, a, { t: 'car_dir', dir: 'up' });
  assert.deepEqual(car().tile, before, 'blocked, but it turned');
  send(w, a, { t: 'move', to: { x: 33, y: 12 } });
  assert.ok(!has(a.u, 'driving'));
  send(w, a, { t: 'cup_take', cupId: car().id }); tick(1000);
  a.u.presence = 'offline'; tick(500);
  assert.ok(!has(a.u, 'driving'));
});

test('achievement hats: picks fall due at 5, 10 and 15 achievements, one hat you don\'t own each', t => {
  assert.deepEqual([4, 5, 9, 10, 15, 20].map(n => picksDue(n)), [0, 1, 1, 2, 3, 3]);
  assert.equal(picksDue(10, 1), 1);
  assert.deepEqual(HAT_REWARDS.map(r => r.at), [5, 10, 15]);
  assert.deepEqual(hatChoices([hatItem('shark')]).length, ACHIEVEMENT_HATS.length - 1);
  const { w, add, notices } = setup(t), a = add('A');
  const earnable = ACHIEVEMENTS.filter(x => !x.soon).map(x => x.id);
  const award = (n: number) => { for (const id of earnable.slice(0, n)) (w as unknown as { award(u: User, id: string, now: number): void }).award(a.u, id, Date.now()); };
  award(4); assert.equal(w.hatDue(a.u), 0); assert.equal(last(a.messages, 'me')?.hatDue, undefined);
  award(5);
  assert.equal(w.hatDue(a.u), 1);
  assert.equal(last(a.messages, 'me')!.hatDue, 1, 'the picker is told');
  assert.ok(notices(a.messages).some(n => n.includes('pick a hat')));
  send(w, a, { t: 'hat_pick', item: hatItem('wizard') });
  assert.equal(w.hatDue(a.u), 1, 'only the achievement pool');
  send(w, a, { t: 'hat_pick', item: hatItem('shark') });
  assert.ok(a.u.items.includes(hatItem('shark')) && a.u.hatPicks === 1 && effectOf(a.u.effects, 'hat')?.data?.style === 'shark');
  assert.equal(w.hatDue(a.u), 0);
  send(w, a, { t: 'hat_pick', item: hatItem('frog') });
  assert.ok(!a.u.items.includes(hatItem('frog')), 'no pick due: no hat');
  award(10); assert.equal(w.hatDue(a.u), 1);
  send(w, a, { t: 'hat_pick', item: hatItem('shark') });
  assert.equal(a.u.hatPicks, 1, 'a hat you already own is refused');
  send(w, a, { t: 'hat_pick', item: hatItem('frog') });
  assert.equal(a.u.hatPicks, 2);
  // saved and restored
  const w2 = new World(map); w2.load(JSON.parse(JSON.stringify(w.dump())));
  assert.equal(w2.users.get(a.u.id)!.hatPicks, 2);
});

test('gm give offers the new items; stickers are one of each', t => {
  const { w, add } = setup(t), gm = add('GM'), a = add('A');
  gm.u.email = 'ivan.baranov@t1a.com';
  for (const item of ['party_popper', 'umbrella', 'sticker_star', 'glow_stick']) send(w, gm, { t: 'gm_give', targetId: a.u.id, item });
  assert.deepEqual(a.u.items.sort(), ['glow_stick', 'party_popper', 'sticker_star', 'umbrella']);
  send(w, gm, { t: 'gm_give', targetId: a.u.id, item: 'sticker_star' });
  assert.equal(a.u.items.filter(i => i === 'sticker_star').length, 1);
});
