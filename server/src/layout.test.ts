import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { isWalkable, seatAt, type TileMap, type Tile } from '../../shared/map';
import type { ServerMsg } from '../../shared/protocol';
const base: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const map = structuredClone(base), w = new World(map);
  const add = (name: string, tile: Tile, email?: string) => {
    const u = w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    const conn = w.connect(u.id, m => messages.push(m));
    u.tile = tile; u.move = null; u.path = null; u.prev = undefined; // standing still where we put them
    messages.length = 0;
    return { u, messages, ...conn };
  };
  return { map, w, add };
}
const notices = (messages: ServerMsg[]) => messages.flatMap(m => (m.t === 'notice' ? [m.text] : []));

test('only admins can rearrange; they hear it in their own settings', t => {
  const { map, w, add } = setup(t);
  const admin = add('Ivan', { x: 4, y: 17 }, 'ivan.baranov@t1a.com'), other = add('Kim', { x: 8, y: 17 }, 'kim@t1a.com');
  assert.equal((w.me(admin.u) as Extract<ServerMsg, { t: 'me' }>).admin, true);
  assert.equal((w.me(other.u) as Extract<ServerMsg, { t: 'me' }>).admin, undefined);
  const shelf = map.objects.find(o => o.type === 'bookshelf' && o.y === 21)!, x = shelf.x;
  w.handle(other.u, { t: 'edit', edit: { op: 'move', id: shelf.id, x: x - 2, y: shelf.y } }, other.socket);
  assert.equal(map.objects.find(o => o.id === shelf.id)!.x, x);
  w.handle(admin.u, { t: 'edit', edit: { op: 'move', id: shelf.id, x: x - 2, y: shelf.y } }, admin.socket);
  assert.equal(map.objects.find(o => o.id === shelf.id)!.x, x - 2);
  assert.ok(other.messages.some(m => m.t === 'layout' && m.by === admin.u.id)); // everyone gets the new floor
  assert.equal(isWalkable(map, x + 1, shelf.y), true); assert.equal(isWalkable(map, x - 2, shelf.y), false);
});

test('edits that break the floor are refused with a reason and change nothing', t => {
  const { map, w, add } = setup(t), a = add('Ivan', { x: 4, y: 17 }, 'ivan.baranov@t1a.com');
  const before = JSON.stringify(map.objects);
  w.edit(a.u, { op: 'add', type: 'plant', x: 6, y: 11 });                  // in the Focus doorway
  w.edit(a.u, { op: 'add', type: 'plant', x: 0, y: 5 });                   // in the outer wall
  w.edit(a.u, { op: 'add', type: 'exit_door', x: 4, y: 12 });              // one of a kind
  w.edit(a.u, { op: 'remove', id: map.objects.find(o => o.type === 'coffee_machine')!.id });
  w.edit(a.u, { op: 'move', id: map.objects.find(o => o.type === 'exit_door')!.id, x: 3, y: 12 });
  const desk = map.objects.find(o => o.type === 'desk')!;
  w.edit(a.u, { op: 'move', id: desk.id, x: desk.x + 2, y: desk.y });       // into the next desk
  assert.equal(JSON.stringify(map.objects), before);
  const said = notices(a.messages);
  assert.ok(said.some(s => s.includes('doorway')), said.join(' | '));
  assert.ok(said.some(s => s.includes('wall')));
  assert.ok(said.some(s => s.includes('needs its coffee machine')));
  assert.ok(said.some(s => s.includes('exit door stays put')));
});

test('a home desk follows its chair, and goes when the chair does', t => {
  const { map, w, add } = setup(t), a = add('Ivan', { x: 4, y: 17 }, 'ivan.baranov@t1a.com'), b = add('Kim', { x: 8, y: 17 });
  const chair = map.objects.find(o => o.type === 'chair' && o.x === 2 && o.y === 5)!;
  b.u.homeDesk = { x: 2, y: 5 };
  w.edit(a.u, { op: 'move', id: chair.id, x: 3, y: 6 });
  assert.deepEqual(b.u.homeDesk, { x: 3, y: 6 }); assert.ok(seatAt(map, 3, 6)?.homeDesk);
  w.edit(a.u, { op: 'move', id: chair.id, x: 4, y: 18 }); // into the Lobby: no home desks there
  assert.equal(b.u.homeDesk, null);
  b.u.homeDesk = { x: 4, y: 18 }; // (as if) — removing a chair always frees its desk
  w.edit(a.u, { op: 'remove', id: chair.id });
  assert.equal(b.u.homeDesk, null);
});

test('furniture put down on someone: they step aside; walkers re-route around it', t => {
  const { map, w, add } = setup(t), a = add('Ivan', { x: 4, y: 17 }, 'ivan.baranov@t1a.com'), b = add('Kim', { x: 8, y: 17 });
  w.edit(a.u, { op: 'add', type: 'plant', x: 8, y: 17 });
  assert.ok(map.objects.some(o => o.type === 'plant' && o.x === 8 && o.y === 17));
  assert.ok(b.u.move); assert.ok(isWalkable(map, b.u.move!.to.x, b.u.move!.to.y));
  // a walk across the lobby, then a sofa dropped in its way
  w.walk(a.u, { x: 4, y: 20 }); const path = a.u.path!.slice();
  const mid = path[Math.floor(path.length / 2)];
  w.edit(a.u, { op: 'add', type: 'lamp', x: mid.x, y: mid.y });
  assert.ok(a.u.path!.every(t => isWalkable(map, t.x, t.y)), 'new path avoids the lamp');
});

test('rugs: add, recolour, resize, never overlapping; layout persists and Reset brings back the original', t => {
  const { map, w, add } = setup(t), a = add('Ivan', { x: 4, y: 17 }, 'ivan.baranov@t1a.com');
  const n = map.rugs.length;
  w.edit(a.u, { op: 'rug_add', x: 2, y: 27 });
  const rug = map.rugs.at(-1)!; assert.equal(map.rugs.length, n + 1);
  assert.ok(a.messages.some(m => m.t === 'layout' && m.added === rug.id)); // so the admin's editor selects it
  w.edit(a.u, { op: 'rug', id: rug.id, color: 'teal', w: 4 });
  assert.deepEqual({ color: map.rugs.at(-1)!.color, w: map.rugs.at(-1)!.w }, { color: 'teal', w: 4 });
  w.edit(a.u, { op: 'rug', id: map.rugs.at(-1)!.id, color: 'plaid' }); assert.ok(notices(a.messages).includes('Can\'t: no such rug'));
  w.edit(a.u, { op: 'rug_add', x: 3, y: 15 }); assert.ok(notices(a.messages).includes('Can\'t: rugs can\'t overlap')); // the Lobby's red rug
  const saved = JSON.parse(JSON.stringify(w.dump()));
  assert.ok(saved.layout);
  const again = new World(structuredClone(base)); again.load(saved);
  assert.equal(again.map.rugs.length, n + 1);
  w.resetLayout(a.u);
  assert.equal(map.rugs.length, n); assert.equal(w.dump().layout, undefined);
});
