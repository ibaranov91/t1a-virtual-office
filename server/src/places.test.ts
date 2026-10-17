import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { applyEdit, besideObject, findPath, layoutProblem, withLayout, type Tile, type TileMap } from '../../shared/map';
import { SHOP_DAILY_MAX, shopLeft, shopProblem, shopStock, shopTake } from '../../shared/shop';
import { advancePomodoro, startPomodoro } from '../../shared/pomodoro';
import { officeDay } from '../../shared/officeTime';
import { keikoCheckout, PHRASES } from '../../shared/phrases';
import { eatSpot } from '../../shared/lunch';
import type { ServerMsg } from '../../shared/protocol';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const shelf = map.objects.find(o => o.use?.kind === 'shop')!, kettle = map.objects.find(o => o.use?.kind === 'kettle')!;

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: Date.UTC(2026, 9, 18, 12) });
  const w = new World(structuredClone(map));
  const add = (name: string, tile: Tile) => {
    const u = w.addUser(name, false, tile); u.presence = 'online';
    const messages: ServerMsg[] = [];
    return { u, messages, ...w.connect(u.id, m => messages.push(m)) };
  };
  return { w, add, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const beside = (o: typeof shelf) => besideObject(map, o).find(s => findPath(map, map.spawn, s).length)!;

test('the shop limit: 3 a day, reset at the office midnight, only stock that exists', () => {
  assert.ok(shopStock().every(d => d.id)); assert.ok(shopStock().some(d => d.id === 'cup_noodles'));
  const noon = Date.UTC(2026, 9, 18, 12);
  let s = shopTake(undefined, 'cup_noodles', noon);
  assert.equal(shopLeft(s, noon), SHOP_DAILY_MAX - 1);
  s = shopTake(shopTake(s, 'cup_noodles', noon), 'cup_noodles', noon);
  assert.match(shopProblem(s, 'cup_noodles', noon) ?? '', /last one/);
  assert.ok(shopProblem(s, 'cup_noodles', Date.UTC(2026, 9, 18, 21, 30)), 'Berlin midnight (22:00 UTC in October) has not come yet...');
  assert.equal(shopProblem(s, 'cup_noodles', Date.UTC(2026, 9, 18, 23, 0)), null, '... and after it a new office day starts');
  assert.equal(shopProblem(undefined, 'sword', noon), 'Not on the shelves');
  assert.equal(officeDay(Date.UTC(2026, 9, 18, 21, 59)), '2026-10-18'); assert.equal(officeDay(Date.UTC(2026, 9, 18, 22, 1)), '2026-10-19');
});

test('the shelves give three things a day into your pockets, enforced and persisted by the server; Keiko comments', t => {
  const { w, add } = setup(t), kim = add('Kim', beside(shelf));
  for (let i = 0; i < 5; i++) w.handle(kim.u, { t: 'shop_take', item: 'cup_noodles' }, kim.socket);
  assert.equal(kim.u.items.filter(i => i === 'cup_noodles').length, SHOP_DAILY_MAX);
  assert.ok(kim.messages.some(m => m.t === 'notice' && /last one/.test(m.text)));
  assert.ok(kim.messages.some(m => m.t === 'npc_say' && m.text === PHRASES.keiko.checkout[1]));
  const saved = w.dump().users.find(u => u.id === kim.u.id)!;
  assert.equal(saved.shop?.taken.length, SHOP_DAILY_MAX);
  const far = add('Far', map.spawn); w.handle(far.u, { t: 'shop_take', item: 'cup_noodles' }, far.socket);
  assert.equal(far.u.items.includes('cup_noodles'), false, 'only beside the shelves');
  assert.equal(JSON.stringify(w.dump()).includes('"shop"') && !JSON.stringify((w as unknown as { toPublic(u: unknown): unknown }).toPublic(kim.u)).includes('"shop"'), true, 'never public');
});

test('cup noodles: dry from the shelves, hot from the kettle, eaten beside a kitchen table', t => {
  const { w, add, tick } = setup(t), kim = add('Kim', beside(shelf));
  w.handle(kim.u, { t: 'shop_take', item: 'cup_noodles' }, kim.socket);
  w.handle(kim.u, { t: 'use', objectId: kettle.id }, kim.socket);
  tick(60_000);
  assert.equal(kim.u.holding, 'hot_noodles'); assert.equal(kim.u.items.includes('cup_noodles'), false);
  const spot = [...map.objects.filter(o => o.type === 'bar_table')].flatMap(o => besideObject(map, o)).find(s => eatSpot(map, s))!;
  w.handle(kim.u, { t: 'lunch', tile: { x: spot.x, y: spot.y }, open: true }, kim.socket);
  tick(60_000);
  assert.equal(kim.u.holding, null); assert.equal(kim.u.eating?.item, 'hot_noodles');
  assert.ok(w.creatures.cups.some(c => c.item === 'plate:hot_noodles'), 'a plate on the table');
  assert.ok(!kim.u.callId?.startsWith('room:table:'), 'no table voice in the kitchen');
});

test('the personal pomodoro: focus, then a break, then done; public, and stoppable', t => {
  const p = startPomodoro(0); assert.deepEqual([p.focus, p.rest], [25, 5]);
  assert.equal(advancePomodoro(p, 25 * 60_000 - 1), null);
  const a = advancePomodoro(p, 25 * 60_000)!; assert.equal(a.next?.phase, 'break'); assert.equal(a.next?.until, 30 * 60_000);
  assert.equal(advancePomodoro(a.next!, 30 * 60_000)!.next, null);
  assert.equal(startPomodoro(0, 9999, 'x').focus, 25, 'bad minutes fall back');
  const { w, add, tick } = setup(t), kim = add('Kim', map.spawn);
  w.handle(kim.u, { t: 'pomodoro', op: 'start' }, kim.socket);
  assert.equal(kim.u.pomodoro?.phase, 'focus');
  tick(25 * 60_000 + 500);
  assert.ok(kim.messages.some(m => m.t === 'pomodoro' && m.chime === 'break'));
  tick(5 * 60_000 + 500);
  assert.equal(kim.u.pomodoro, undefined); assert.ok(kim.messages.some(m => m.t === 'pomodoro' && m.chime === 'done'));
  w.handle(kim.u, { t: 'pomodoro', op: 'start', focus: 10 }, kim.socket); w.handle(kim.u, { t: 'pomodoro', op: 'stop' }, kim.socket);
  assert.equal(kim.u.pomodoro, undefined);
});

test('Keiko names what you took, and the generated layout keeps new furniture honest', () => {
  assert.match(keikoCheckout(['onigiri', 'slurpee'], ['Onigiri', 'Slurpee']), /^Onigiri and slurpee\. Yesterday too/);
  assert.equal(PHRASES.keiko.greeting.length + PHRASES.keiko.checkout.length + PHRASES.keiko.idle.length + PHRASES.keiko.talk.length, 16);
  assert.equal(layoutProblem(map), null);
  const door = map.objects.find(o => o.type === 'shop_counter')!;
  const blocked = applyEdit(map, { op: 'move', id: door.id, x: 64, y: 17 }, () => 'n');
  assert.ok(typeof blocked === 'string' || layoutProblem(withLayout(map, blocked)) !== null, 'furniture on the 7/11 doorway is refused');
  assert.ok(map.rooms.every(r => r.spots.length > 0), 'every room has somewhere to stand');
});
