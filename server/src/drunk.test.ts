import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { isWalkable, roomAt, seatAt, type Tile, type TileMap } from '../../shared/map';
import type { ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
function setup(t: TestContext, bot = false) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const w = new World(structuredClone(map)), bar = w.map.objects.find(o => o.type === 'beach_bar')!;
  w.rng = () => 0;
  const u = w.addUser(bot ? 'Bot guest' : 'Beach guest', bot, { x: bar.x, y: bar.y + bar.h });
  u.presence = 'online';
  const messages: ServerMsg[] = [], { socket } = w.connect(u.id, m => messages.push(m));
  const room = roomAt(w.map, u.tile.x, u.tile.y);
  const open = (x: number, y: number) => isWalkable(w.map, x, y) && roomAt(w.map, x, y) === room && !seatAt(w.map, x, y);
  let target: Tile | undefined; // a floor tile in the bar's room with free floor all around it
  for (let d = 2; d < 12 && !target; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
    const x = u.tile.x + dx, y = u.tile.y + dy;
    if (open(x, y) && open(x, y - 1) && open(x + 1, y) && open(x, y + 1) && open(x - 1, y)) { target = { x, y }; break; }
  }
  const move = (to: Tile) => { w.handle(u, { t: 'move', to }, socket); return messages.filter(m => m.t === 'move').at(-1) as Extract<ServerMsg, { t: 'move' }>; };
  const drink = (n = 1) => { for (let i = 0; i < n; i++) w.addEffect(u, 'drunk', { ms: 60_000, data: { level: i + 1 } }); };
  return { w, u, bar, messages, socket, target: target!, move, drink };
}

test('a drunk human sometimes lands a tile off, and every client gets the swapped destination', t => {
  const { u, messages, target, move, drink } = setup(t);
  drink();
  const m = move(target);
  assert.deepEqual(m.to, { x: target.x, y: target.y - 1 }, 'rng 0 picks the first free neighbour (above)');
  assert.deepEqual(u.tile, m.to);
  assert.ok(messages.some(x => x.t === 'notice' && x.text.includes('Not quite')));
  const notices = messages.filter(x => x.t === 'notice').length;
  move({ x: target.x + 1, y: target.y });
  assert.equal(messages.filter(x => x.t === 'notice').length, notices, 'at most one notice every 10 s');
});

test('a sober human lands where they clicked, and so does a lucky drunk', t => {
  const { w, target, move, drink } = setup(t);
  assert.deepEqual(move(target).to, target);
  drink(); w.rng = () => 0.99;
  assert.deepEqual(move({ x: target.x - 1, y: target.y }).to, { x: target.x - 1, y: target.y });
});

test('bots never mis-walk', t => {
  const { target, move, drink } = setup(t, true);
  drink(3);
  assert.deepEqual(move(target).to, target);
});

test('the bar hands out happy hour on the first round, closing time on the third, designated driver on a handed drink', t => {
  const { w, u, bar, socket } = setup(t);
  const take = (item: string) => { w.use(u, bar.id, item); t.mock.timers.tick(1250); w.handle(u, { t: 'drink' }, socket); t.mock.timers.tick(2500); }; // take it, then drink it
  take('cocktail');
  assert.ok(u.achievements.happy_hour);
  assert.equal(u.achievements.closing_time, undefined);
  take('beer'); take('wine');
  assert.ok(u.achievements.closing_time);
  const friend = w.addUser('Friend', false, { x: bar.x + 1, y: bar.y + bar.h });
  w.onGiven(friend, 'coffee', u); assert.equal(u.achievements.designated, undefined);
  w.onGiven(friend, 'cocktail', u); assert.ok(u.achievements.designated);
});
