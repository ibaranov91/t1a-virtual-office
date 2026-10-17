import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, STATE_VERSION, type User } from './world';
import type { TileMap, Tile } from '../../shared/map';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import { DRINKS } from '../../shared/drinks';
import { ITEM_DEFS, POCKET_MAX, PRISON_MS, canCarry, heldActions, isThrowable, itemDef, pocketCount, pocketProblem } from '../../shared/items';
import { hatItem } from '../../shared/effects';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const GM_EMAIL = 'ivan.baranov@t1a.com';
const DESK: Tile = { x: 32, y: 12 };

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const add = (name: string, tile: Tile = DESK, email?: string) => {
    const u = w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    return { u, messages, ...w.connect(u.id, m => messages.push(m)) };
  };
  const notices = (m: ServerMsg[]) => m.flatMap(x => (x.t === 'notice' ? [x.text] : []));
  return { w, add, notices, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const last = <T extends ServerMsg['t']>(m: ServerMsg[], type: T) => m.filter((x): x is Extract<ServerMsg, { t: T }> => x.t === type).at(-1);
const send = (w: World, p: { u: User; socket: string }, msg: ClientMsg) => w.handle(p.u, msg, p.socket);

test('registry: drinks derive from it, hats are free, and every drink/food has a definition', () => {
  assert.deepEqual(Object.keys(DRINKS).sort(), ['beer', 'cocktail', 'coconut', 'coffee', 'icecream', 'tea', 'wine']);
  assert.equal(DRINKS.coffee.autoSipMs, 60_000);
  assert.equal(itemDef('hat:wizard')?.pocket, 'free');
  assert.equal(itemDef('hat:never-heard-of')?.kind, 'hat', 'any hat:<style> is a hat');
  assert.equal(itemDef('nonsense'), undefined);
  for (const id of ['coffee', 'sandwich', 'snack', 'juice', 'book', 'drugs']) assert.ok(ITEM_DEFS[id], id);
  assert.ok(isThrowable('drugs') && !isThrowable('coffee') && !isThrowable('hat:top'));
  assert.ok(canCarry('drugs') && canCarry('hat:top') && !canCarry('coffee'));
  assert.deepEqual(heldActions('coffee'), ['drink']);
  assert.deepEqual(heldActions('coffee', true), ['drop']);
});

test('pocket limit: six counted items, hats are free and one each', () => {
  const six = Array(POCKET_MAX).fill('drugs');
  assert.equal(pocketProblem(six.slice(1), 'drugs'), null);
  assert.equal(pocketProblem(six, 'drugs'), 'Your pockets are full');
  assert.equal(pocketProblem(six, 'hat:crown'), null, 'a full pocket still takes a hat');
  assert.equal(pocketProblem([...six, 'hat:crown'], 'hat:crown'), 'You already have that hat');
  assert.equal(pocketProblem([], 'coffee'), 'That doesn\'t fit in your pockets');
  assert.equal(pocketCount([...six, 'hat:crown', 'hat:top']), POCKET_MAX);
});

test('moveItem: limits, no duplicates, nothing from nowhere', t => {
  const { w, add } = setup(t), a = add('A');
  const pockets = { kind: 'pockets' as const, id: a.u.id }, desk = { kind: 'desk' as const, id: a.u.id }, hands = { kind: 'hands' as const, id: a.u.id };
  a.u.items = Array(POCKET_MAX).fill('drugs');
  assert.equal(w.moveItem('drugs', { kind: 'void' }, pockets, null), 'Your pockets are full');
  assert.equal(a.u.items.length, POCKET_MAX, 'a refused move changes nothing');
  assert.equal(w.moveItem('drugs', pockets, desk, a.u), null);
  assert.deepEqual([a.u.items.length, w.desk(a.u).items], [POCKET_MAX - 1, ['drugs']], 'it left one place and entered the other');
  assert.equal(w.moveItem('hat:top', pockets, desk, a.u), 'Not there', 'you can\'t move what you don\'t have');
  assert.equal(w.moveItem('drugs', pockets, pockets, a.u), 'Already there');
  assert.equal(w.moveItem('drugs', desk, hands, a.u), null);
  assert.equal(a.u.holding, 'drugs'); assert.equal(w.desk(a.u).items.length, 0);
  assert.equal(w.moveItem('drugs', pockets, hands, a.u), 'Your hands are full');
  assert.equal(w.moveItem('coffee', { kind: 'void' }, desk, null), 'That doesn\'t fit', 'a coffee isn\'t pocketable');
  assert.equal(w.moveItem('drugs', { kind: 'shelf', id: 'trophy' }, pockets, null), 'Not there');
  assert.equal(w.moveItem('drugs', hands, { kind: 'shelf', id: 'trophy' }, a.u), null, 'generic containers work the same');
  assert.deepEqual(w.shelf('trophy').items, ['drugs']);
  assert.equal(a.u.holding, null);
});

test('held items: take out of pockets, stow, drop to the floor; pocketables never fade from the hand', t => {
  const { w, add, notices, tick } = setup(t), a = add('A');
  a.u.items = ['drugs', 'hat:top'];
  send(w, a, { t: 'take_out', item: 'hat:top' });
  assert.equal(a.u.holding, null, 'hats are worn, not held');
  send(w, a, { t: 'take_out', item: 'drugs' });
  assert.equal(a.u.holding, 'drugs'); assert.deepEqual(a.u.items, ['hat:top']);
  send(w, a, { t: 'take_out', item: 'drugs' });
  assert.ok(notices(a.messages).includes('Your hands are full'));
  tick(10 * 60_000);
  assert.equal(a.u.holding, 'drugs', 'no 3-minute fade for something you carry');
  send(w, a, { t: 'stow' });
  assert.deepEqual([a.u.holding, a.u.items], [null, ['hat:top', 'drugs']]);
  send(w, a, { t: 'take_out', item: 'drugs' });
  send(w, a, { t: 'drop' });
  const prop = w.creatures.cups.find(c => c.item === 'drugs')!;
  assert.ok(prop && prop.floor && prop.by === a.u.id && prop.ttl, 'on the floor, owned, with a lifetime');
  assert.equal(a.u.holding, null);
  // someone picks it up (their hands, since empty)
  const b = add('B', { x: prop.tile.x, y: prop.tile.y });
  send(w, b, { t: 'cup_take', cupId: prop.id });
  tick(15_000);
  assert.equal(b.u.holding, 'drugs'); assert.equal(w.creatures.cups.some(c => c.item === 'drugs'), false);
});

test('give = throw: lands in their pockets, else at their feet; far away or offline is refused; a drink is still handed over', t => {
  const { w, add, notices } = setup(t), a = add('A', { x: 32, y: 12 }), b = add('B', { x: 35, y: 12 });
  a.u.items = ['drugs'];
  send(w, a, { t: 'take_out', item: 'drugs' });
  send(w, a, { t: 'give', targetId: b.u.id });
  assert.deepEqual([a.u.holding, b.u.items], [null, ['drugs']]);
  const flight = last(b.messages, 'thrown')!;
  assert.deepEqual([flight.fromId, flight.toId, flight.item, flight.landed], [a.u.id, b.u.id, 'drugs', 'pockets']);
  assert.ok(notices(b.messages).some(n => n.includes('threw you')));
  // pockets full: it lands beside them as a prop
  b.u.items = Array(POCKET_MAX).fill('drugs'); a.u.items = ['drugs'];
  send(w, a, { t: 'take_out', item: 'drugs' }); send(w, a, { t: 'give', targetId: b.u.id });
  assert.equal(last(b.messages, 'thrown')!.landed, 'floor');
  assert.equal(b.u.items.length, POCKET_MAX);
  const prop = w.creatures.cups.find(c => c.item === 'drugs')!;
  assert.ok(Math.abs(prop.tile.x - 35) + Math.abs(prop.tile.y - 12) <= 1 && prop.floor && prop.by === a.u.id);
  // too far
  const far = add('Far', { x: 60, y: 12 }); a.u.items = ['drugs'];
  send(w, a, { t: 'take_out', item: 'drugs' }); send(w, a, { t: 'give', targetId: far.u.id });
  assert.equal(a.u.holding, 'drugs'); assert.ok(notices(a.messages).includes('Too far to throw'));
  // a coffee is handed over, not thrown
  const c = add('C', { x: 33, y: 12 });
  w.setHolding(a.u, 'coffee');
  send(w, a, { t: 'give', targetId: c.u.id });
  assert.deepEqual([a.u.holding, c.u.holding], [null, 'coffee']);
});

test('desk storage: own deposit and withdraw, no size limit, saved and restored', t => {
  const { w, add } = setup(t), a = add('A');
  a.u.homeDesk = { ...DESK };
  a.u.items = Array(POCKET_MAX).fill('drugs');
  send(w, a, { t: 'storage_move', ownerId: a.u.id, item: 'drugs', dir: 'in' });
  assert.equal(w.desk(a.u).items.length, 0, 'not open yet');
  send(w, a, { t: 'storage_open', ownerId: a.u.id });
  assert.deepEqual(last(a.messages, 'storage')!.items, []);
  for (let i = 0; i < POCKET_MAX; i++) send(w, a, { t: 'storage_move', ownerId: a.u.id, item: 'drugs', dir: 'in' });
  assert.deepEqual([a.u.items.length, last(a.messages, 'storage')!.items.length], [0, POCKET_MAX]);
  for (let i = 0; i < POCKET_MAX; i++) { a.u.items.push('drugs'); send(w, a, { t: 'storage_move', ownerId: a.u.id, item: 'drugs', dir: 'in' }); }
  assert.equal(w.desk(a.u).items.length, POCKET_MAX * 2, 'storage has no limit');
  send(w, a, { t: 'storage_move', ownerId: a.u.id, item: 'drugs', dir: 'out' });
  assert.equal(a.u.items.length, 1);
  assert.equal(w.desk(a.u).log.length, 0, 'your own withdrawals aren\'t thefts');
  const w2 = new World(structuredClone(map)); w2.load(JSON.parse(JSON.stringify(w.dump())));
  assert.equal(w2.desk(w2.users.get(a.u.id)!).items.length, POCKET_MAX * 2 - 1);
  assert.equal(w.dump().version, STATE_VERSION);
});

test('someone else\'s storage: a warning first, spotted only if anyone is in the room, theft logs and imprisons', t => {
  const { w, add, notices, tick } = setup(t), owner = add('Owner', { x: 20, y: 8 }), thief = add('Thief');
  owner.u.homeDesk = { ...DESK }; w.desk(owner.u).items = ['drugs', 'hat:crown'];
  send(w, thief, { t: 'storage_open', ownerId: owner.u.id });
  assert.equal(last(thief.messages, 'storage_warn')?.ownerId, owner.u.id);
  assert.equal(last(thief.messages, 'storage'), undefined, 'nothing until they confirm');
  // alone in the room (the owner is elsewhere): not spotted
  send(w, thief, { t: 'storage_open', ownerId: owner.u.id, ack: true });
  assert.equal(last(thief.messages, 'storage')!.spotted, undefined);
  assert.equal(thief.u.achievements.snoop, undefined);
  assert.equal(last(thief.messages, 'storage')!.log, undefined, 'only the owner sees the log');
  // a witness walks in: spotted
  const witness = add('Witness', { x: 33, y: 12 });
  send(w, thief, { t: 'storage_open', ownerId: owner.u.id, ack: true });
  assert.equal(last(thief.messages, 'storage')!.spotted, true);
  assert.ok(thief.u.achievements.snoop, 'a bad achievement');
  assert.ok(notices(owner.messages).some(n => n.includes('going through your desk')));
  // can't put things in someone else's desk
  thief.u.items = ['drugs'];
  send(w, thief, { t: 'storage_move', ownerId: owner.u.id, item: 'drugs', dir: 'in' });
  assert.equal(w.desk(owner.u).items.length, 2);
  // the theft
  send(w, thief, { t: 'storage_move', ownerId: owner.u.id, item: 'drugs', dir: 'out' });
  assert.deepEqual(w.desk(owner.u).items, ['hat:crown']);
  assert.deepEqual(w.desk(owner.u).log.map(l => [l.name, l.item]), [['Thief', 'drugs']]);
  assert.ok(notices(owner.messages).some(n => n.includes('Thief took your drugs')));
  assert.ok(thief.u.prisonUntil! >= Date.now() + PRISON_MS - 1000);
  assert.equal(thief.u.effects.find(e => e.kind === 'hat')?.data?.style, 'prison');
  assert.equal(last(thief.messages, 'me')!.prisonUntil, thief.u.prisonUntil);
  // the hat stays: not by choice, not by wearing another
  thief.u.items = [...thief.u.items, hatItem('top')];
  send(w, thief, { t: 'effect', targetId: thief.u.id, kind: 'hat', on: false });
  send(w, thief, { t: 'effect', targetId: thief.u.id, kind: 'hat', on: true, style: 'top' });
  assert.equal(thief.u.effects.find(e => e.kind === 'hat')?.data?.style, 'prison');
  assert.ok(notices(thief.messages).some(n => n.includes('prison hat stays on')));
  // the owner sees the list when they open their own desk
  send(w, owner, { t: 'storage_open', ownerId: owner.u.id }); // too far from the desk
  assert.ok(notices(owner.messages).includes('Walk up to the plant first'));
  owner.u.tile = { ...DESK }; owner.u.move = null;
  send(w, owner, { t: 'storage_open', ownerId: owner.u.id });
  assert.deepEqual(last(owner.messages, 'storage')!.log!.map(l => l.name), ['Thief']);
  // a second theft doesn't extend it; waiting it out doesn't release early
  const until = thief.u.prisonUntil;
  send(w, thief, { t: 'storage_move', ownerId: owner.u.id, item: 'hat:crown', dir: 'out' });
  assert.equal(thief.u.prisonUntil, until); assert.equal(w.desk(owner.u).log.length, 2);
  tick(PRISON_MS - 1000);
  assert.equal(thief.u.effects.find(e => e.kind === 'hat')?.data?.style, 'prison');
  tick(2000);
  assert.equal(thief.u.prisonUntil, undefined); assert.equal(thief.u.effects.some(e => e.kind === 'hat'), false, 'served: the hat comes off');
  void witness;
});

test('an office admin can take the prison hat off, give any item, and release by effect too', t => {
  const { w, add } = setup(t), owner = add('Owner'), thief = add('Thief'), gm = add('Gm', DESK, GM_EMAIL), bystander = add('B');
  owner.u.homeDesk = { ...DESK }; w.desk(owner.u).items = ['drugs'];
  send(w, thief, { t: 'storage_open', ownerId: owner.u.id, ack: true });
  send(w, thief, { t: 'storage_move', ownerId: owner.u.id, item: 'drugs', dir: 'out' });
  assert.ok(w.prisonActive(thief.u));
  send(w, bystander, { t: 'prison_release', targetId: thief.u.id });
  assert.ok(w.prisonActive(thief.u), 'only admins release');
  send(w, gm, { t: 'prison_release', targetId: thief.u.id });
  assert.equal(w.prisonActive(thief.u), false); assert.equal(thief.u.effects.some(e => e.kind === 'hat'), false);
  assert.equal(last(thief.messages, 'me')!.prisonUntil, undefined);
  // another way: the GM panel's hat toggle
  w.moveItem('drugs', { kind: 'pockets', id: thief.u.id }, { kind: 'desk', id: owner.u.id }, thief.u);
  send(w, thief, { t: 'storage_move', ownerId: owner.u.id, item: 'drugs', dir: 'out' });
  assert.ok(w.prisonActive(thief.u));
  send(w, gm, { t: 'effect', targetId: thief.u.id, kind: 'hat', on: false });
  assert.equal(w.prisonActive(thief.u), false);
  // gm_give: any registry item, admins only
  send(w, bystander, { t: 'gm_give', targetId: thief.u.id, item: 'drugs' });
  const before = thief.u.items.length;
  send(w, gm, { t: 'gm_give', targetId: thief.u.id, item: 'nonsense' });
  send(w, gm, { t: 'gm_give', targetId: thief.u.id, item: 'empty:coffee' });
  assert.equal(thief.u.items.length, before);
  send(w, gm, { t: 'gm_give', targetId: thief.u.id, item: 'drugs' });
  assert.equal(thief.u.items.length, before + 1);
  send(w, gm, { t: 'gm_give', targetId: thief.u.id, item: 'hat:laurel' });
  assert.ok(thief.u.items.includes('hat:laurel'));
  send(w, gm, { t: 'gm_give', targetId: bystander.u.id, item: 'coffee' });
  assert.equal(bystander.u.holding, 'coffee', 'things that don\'t go in pockets go in the hands');
  thief.u.items = Array(POCKET_MAX).fill('drugs');
  send(w, gm, { t: 'gm_give', targetId: thief.u.id, item: 'drugs' });
  assert.ok(w.creatures.cups.some(c => c.item === 'drugs' && c.by === gm.u.id), 'full pockets: it lands beside them');
});

test('held items and desk storage survive a restart; props on the floor are kept, floor cups are swept', t => {
  const { w, add } = setup(t), a = add('A');
  a.u.items = ['drugs', 'drugs']; send(w, a, { t: 'take_out', item: 'drugs' });
  send(w, a, { t: 'drop' }); send(w, a, { t: 'take_out', item: 'drugs' });
  w.creatures.addCup({ ...DESK }, 'coffee', Date.now(), { floor: true, by: a.u.id });
  w.shelf('trophy_case').items = ['hat:crown'];
  const w2 = new World(structuredClone(map)); w2.load(JSON.parse(JSON.stringify(w.dump())));
  assert.equal(w2.users.get(a.u.id)!.holding, 'drugs', 'what you carried is still in your hand');
  assert.deepEqual(w2.shelf('trophy_case').items, ['hat:crown']);
  assert.equal(w2.creatures.cups.some(c => c.item === 'coffee'), false);
  assert.equal(w2.creatures.cups.some(c => c.item === 'drugs'), true, 'the dropped item is still lying there');
});
