import test from 'node:test';
import assert from 'node:assert/strict';
import mapJson from '../../shared/tilemap.json';
import { roomAt, type TileMap } from '../../shared/map';
import { INSTRUMENTS } from '../../shared/instruments';
import { OFFICE_SCOPE } from '../../shared/protocol';
import type { ClientUser } from './net';
import { activityLine, channelTree, GROUPS, peopleGroups, place, roomGroup, roomThings, splitStatus, joinStatus, type View } from './sidebar/model';
const map = mapJson as unknown as TileMap;
const room = (id: string) => map.rooms.find(r => r.id === id)!;
function user(id: string, name = id, roomId = 'coffee', extra: Partial<ClientUser> = {}): ClientUser {
  return { id, name, look: { skin: '#fff', hair: '#000', shirt: '#000', pants: '#000', eyes: '#000', shoes: '#000', glassesColor: '#000', hatColor: '#000', style: 0, top: 0, bottom: 0, glasses: 0, hat: 0, beard: 0, mustache: 0 },
    lookSet: true, tile: { x: room(roomId).rect.x, y: room(roomId).rect.y }, dir: 'down', move: null, presence: 'online', status: '', emote: null, bot: false, door: null, homeDesk: null,
    callId: null, game: null, deafened: false, hand: false, muted: false, following: null, holding: null, reading: null, meeting: null, instance: null, plant: null, bloomed: [], achievements: {}, effects: [], path: null, prev: null, faceOverride: null, ...extra };
}
function view(...us: ClientUser[]): View {
  return { users: new Map(us.map(u => [u.id, u])), me: 'me',
    roomOf: u => roomAt(map, u.tile.x, u.tile.y), roomCallOf: u => u?.callId?.startsWith('room:') ? room(u.callId.slice(5)) : undefined,
    callPeers(u) { return [...this.users.values()].filter(p => p.id !== u.id && !!u.callId && p.callId === u.callId); },
    names: us => us.map(u => u.name).join(' and '), clock: () => '14:30', instruments: {}, jukebox: {}, presentation: null, sysadmin: false };
}
test('all 18 rooms derive their groups from rules, in map order', () => {
  const expected = { voice: ['Coffee', 'Music', 'Arcade', 'Book Club'], knock: ['Lobby', 'Co-working', 'Desks', 'Orangery', 'Garden', 'Admin', 'Berghain', 'Terrace', 'Mountains', 'Beach'], quiet: ['Focus', 'Meeting', 'Studio', 'Library'] };
  assert.equal(map.rooms.length, 18);
  for (const [id, names] of Object.entries(expected)) assert.deepEqual(map.rooms.filter(r => roomGroup(r) === id).map(r => r.name).sort(), names.sort());
  const tree = channelTree(view(), map);
  assert.deepEqual(tree.map(g => g.id), ['voice', 'knock', 'quiet']);
  for (const g of tree) assert.deepEqual(g.rooms.map(r => r.room.id), map.rooms.filter(r => roomGroup(r) === g.id).map(r => r.id));
});
test('group order, live groups, instances, offline and stable person ordering', () => {
  const v = view(user('z', 'Zoe'), user('a', 'Amy'), user('me', 'You'), user('mt', 'Meeting', 'coffee', { instance: 'event:1' }),
    user('d', 'Digger', 'coffee', { instance: 'dungeon' }), user('h', 'Hall', 'coffee', { tile: { x: 0, y: 0 } }), user('o', 'Offline', 'coffee', { presence: 'offline' }),
    user('v', 'Vacationer', 'coffee', { presence: 'offline', vacation: { until: Date.now() + 86_400_000 } }));
  const tree = channelTree(v, map);
  assert.deepEqual(tree.map(g => g.id), GROUPS.map(g => g.id));
  assert.deepEqual(tree[0].rooms.find(r => r.room.id === 'coffee')!.people.map(u => u.id), ['me', 'a', 'z']);
  assert.equal(tree[0].count, 3);
  for (const id of ['meetings', 'underground', 'hall', 'vacation', 'offline']) assert.equal(tree.find(g => g.id === id)!.people.length, 1);
  assert.equal(place(v, v.users.get('mt')!), 'In a meeting room');
  assert.equal(place(v, v.users.get('d')!), 'Underground');
  assert.equal(place(v, v.users.get('h')!), 'Hallway');
});
test('room and person search, empty matches, live and offline matches', () => {
  const v = view(user('a', 'Alice'), user('b', 'Bob'), user('o', 'Offline Alice', 'coffee', { presence: 'offline' }));
  const coffee = channelTree(v, map, 'COFFEE');
  assert.deepEqual(coffee.map(g => g.id), ['voice']);
  assert.deepEqual(coffee[0].rooms[0].people.map(u => u.id), ['a', 'b']);
  const alice = channelTree(v, map, 'ALIce');
  assert.deepEqual(alice.map(g => g.id), ['voice', 'offline']);
  assert.deepEqual(alice[0].rooms[0].people.map(u => u.id), ['a']);
  assert.equal(alice[1].people[0].id, 'o');
  assert.deepEqual(channelTree(v, map, 'Focus').map(g => [g.id, g.rooms[0].count]), [['quiet', 0]]);
  assert.deepEqual(channelTree(v, map, 'no such person'), []);
  const special = view(user('m', 'Match', 'coffee', { instance: 'event' }));
  assert.deepEqual(channelTree(special, map, 'match').map(g => g.id), ['meetings']);
});
test('people grouping, you first, name ordering, search by shown place', () => {
  const v = view(user('z', 'Zoe'), user('a', 'Amy'), user('me', 'You'), user('c', 'Call', 'focus', { callId: 'knock:1', presence: 'away' }),
    user('b', 'Busy', 'focus', { presence: 'in_call' }), user('away', 'Away', 'coffee', { presence: 'away' }), user('off', 'Offline', 'coffee', { presence: 'offline' }));
  assert.deepEqual(peopleGroups(v).map(g => g.id), ['p-voice', 'p-online', 'p-away', 'offline']);
  assert.deepEqual(peopleGroups(v)[1].people.map(u => u.id), ['me', 'a', 'b', 'z']);
  assert.deepEqual(peopleGroups(v, 'focus').flatMap(g => g.people.map(u => u.id)), ['c', 'b']);
  assert.equal(peopleGroups(v, 'offline')[0].id, 'offline');
  assert.deepEqual(peopleGroups(v, 'absent'), []);
});
test('every activity branch, precedence and status joining', () => {
  const base = user('a'), v = view(base, user('b', 'Ines', 'coffee', { callId: 'knock:1' }));
  const cases: [Partial<ClientUser>, string][] = [
    [{ instance: 'dungeon', door: 'arriving', status: 'secret' }, 'somewhere underground'],
    [{ door: 'arriving', meeting: 1 }, 'just arrived'], [{ door: 'thinking' }, 'packing up…'], [{ door: 'leaving' }, 'heading out'],
    [{ meeting: 1, callId: 'knock:1' }, '📅 in a meeting until 14:30'], [{ callId: 'knock:1', reading: 'article' }, '📞 with Ines'],
    [{ game: { cabinet: 'o1', role: 'player' }, reading: 'article' }, '🕹 playing Deck Park'],
    [{ game: { cabinet: 'o1', role: 'spectator' } }, '👀 watching Deck Park'], [{ reading: 'article' }, '📖 reading'],
    [{ eating: { item: 'food', until: 0, open: false } }, '🍽 having lunch'],
    [{ eating: { item: 'food', until: 0, open: true } }, '🍽 having lunch · open to talk'],
    [{ listening: 'lofi', presence: 'away' }, '🎧 listening to Lofi Girl'],
    [{ presence: 'away' }, 'away'], [{ status: 'debugging' }, 'debugging'], [{}, ''], [{ callId: 'room:coffee' }, ''],
  ];
  for (const [extra, expected] of cases) {
    assert.equal(activityLine(v, { ...base, ...extra }), expected);
    const joined = activityLine(v, { ...base, ...extra, status: 'working' });
    assert.equal(joined, extra.instance === 'dungeon' ? 'somewhere underground' : expected && !extra.status ? `${expected} · working` : 'working');
  }
  const o = map.objects.find(o => o.use?.kind === 'instrument')!;
  assert.equal(o.use?.kind, 'instrument');
  if (o.use?.kind !== 'instrument') throw new Error('instrument missing');
  v.instruments[o.id] = base.id;
  const info = INSTRUMENTS[o.use.instrument];
  assert.equal(activityLine(v, { ...base, presence: 'away', status: 'practice' }), `${info.icon} playing ${info.name} · practice`);
  assert.equal(activityLine(v, { ...base, reading: 'a' }), '📖 reading');
});
test('room things include wall fixtures, dedupe clocks and exclude on-site actions', () => {
  const expected: Record<string, string[]> = { music: ['jukebox', 'youtube'], cowork: ['meetings', 'clock', 'calendar'], lobby: ['achievements', 'link'], arcade: ['records'], library: ['library'], focus: [], coffee: ['calendar'], berghain: ['jukebox'] };
  for (const [id, kinds] of Object.entries(expected)) assert.deepEqual(roomThings(map, room(id)).map(o => o.use!.kind).sort(), kinds.sort(), id);
  const box = roomThings(map, room('music')).find(o => o.use.kind === 'jukebox')!;
  const duplicate = { ...box, id: 'second-box' };
  assert.equal(roomThings({ ...map, objects: [...map.objects, duplicate] }, room('music')).filter(o => o.use.kind === 'jukebox').length, 2);
});
test('counts exclude instances/offline, and subtitle reflects music/presentation', () => {
  const v = view(user('0'), user('1'), user('2'), user('off', 'off', 'coffee', { presence: 'offline' }), user('instance', 'Instance', 'coffee', { instance: 'event' }));
  const coffee = () => channelTree(v, map)[0].rooms.find(r => r.room.id === 'coffee')!;
  assert.equal(coffee().count, 3);
  v.users.delete('0'); assert.equal(coffee().count, 2);
  const box = roomThings(map, room('music')).find(o => o.use.kind === 'jukebox')!;
  v.jukebox[box.id] = { playId: 'play', track: 'unknown-track', by: null, startedAt: 0, pausedAt: null, queue: [], last: null };
  const music = () => channelTree(v, map).flatMap(g => g.rooms).find(r => r.room.id === 'music')!;
  assert.equal(music().subtitle, '♪ unknown-track'); v.jukebox[box.id].pausedAt = 1; assert.equal(music().subtitle, 'paused');
  v.presentation = { scope: OFFICE_SCOPE, deck: null, slide: 0, presenter: 'me', objectId: 'screen', room: 'focus' };
  const focus = () => channelTree(v, map).flatMap(g => g.rooms).find(r => r.room.id === 'focus')!;
  assert.equal(focus().subtitle, '📽 live');
  v.presentation = { ...v.presentation, scope: 'event' }; assert.equal(focus().subtitle, ''); // a meeting room's show stays inside it
});

test('splitStatus keeps a leading emoji sequence together and trims the text', () => {
  const cases: [string, string | null, string][] = [
    ['  Lunch  ', null, 'Lunch'], ['🍔 Lunch', '🍔', 'Lunch'], ['🧑‍💻 coding', '🧑‍💻', 'coding'],
    ['👍🏽 ok', '👍🏽', 'ok'], ['🗓️ In a meeting', '🗓️', 'In a meeting'], ['🎧', '🎧', ''],
    ['Lunch 🍔 soon', null, 'Lunch 🍔 soon'], ['', null, ''],
  ];
  for (const [status, emoji, text] of cases) assert.deepEqual(splitStatus(status), { emoji, text });
});
test('joinStatus round-trips, trims and caps the single status string at 80', () => {
  for (const status of ['🍔 Lunch', '🧑‍💻 coding', '👍🏽 ok', '🗓️ In a meeting', '🎧', 'Lunch 🍔 soon', '']) {
    const { emoji, text } = splitStatus(status);
    assert.equal(joinStatus(emoji, text), status);
  }
  assert.equal(joinStatus(null, '  Lunch  '), 'Lunch');
  assert.equal(joinStatus('🍔', 'x'.repeat(100)), `🍔 ${'x'.repeat(77)}`);
  assert.equal(joinStatus(null, 'x'.repeat(100)).length, 80);
});
test('activityLine shows status text without repeating its leading emoji', () => {
  const u = user('a', 'Amy', 'coffee', { presence: 'away', status: '🍔 Lunch' });
  const v = view(u);
  assert.equal(activityLine(v, u), 'away · Lunch');
  u.presence = 'online';
  assert.equal(activityLine(v, u), 'Lunch');
  u.status = '🎧';
  assert.equal(activityLine(v, u), '');
  u.presence = 'away';
  assert.equal(activityLine(v, u), 'away');
});

test('banner backgrounds cover defaults, colors, each pixel pattern and images', async () => {
  const { bannerStyle } = await import('./sidebar/model');
  const { BANNER_PATTERNS } = await import('../../shared/protocol');
  const look = user('banner').look;
  assert.equal(bannerStyle(undefined, look), look.shirt);
  assert.equal(bannerStyle(null, look), look.shirt);
  assert.equal(bannerStyle({ kind: 'color', color: '#123456' }, look), '#123456');
  const backgrounds = BANNER_PATTERNS.map(pattern => bannerStyle({ kind: 'pattern', pattern, color: '#123456' }, look));
  assert.equal(new Set(backgrounds).size, 6);
  for (const background of backgrounds) { assert.match(background, /gradient\(/); assert.match(background, /color-mix\(in srgb, #123456 70%, black\)/); }
  assert.match(backgrounds[0], /45deg/); assert.match(backgrounds[1], /8px/); assert.match(backgrounds[3], /3px.*12px/);
  assert.equal(bannerStyle({ kind: 'image', url: '/banners/test.png' }, look), 'url("/banners/test.png") center / cover');
});
