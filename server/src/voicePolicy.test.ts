import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import type { Tile, TileMap } from '../../shared/map';
import { CALL_SILENCE_MS, ROOM_VOICE_MAX, type ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const w = new World(map);
  const add = (name: string, tile: Tile = { x: 33, y: 29 }, tab?: string) => {
    const u = w.addUser(name, false, tile); u.presence = 'online';
    const messages: ServerMsg[] = [];
    return { u, messages, ...w.connect(u.id, m => messages.push(m), undefined, tab) };
  };
  return { w, add, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('afk leaves hall voice and walks home; only active restores hall eligibility', t => {
  const { w, add } = setup(t), a = add('A', { x: 32, y: 8 });
  a.u.homeDesk = { x: 33, y: 29 };
  w.voiceTick(); assert.equal(a.u.callId, 'room:coffee');
  w.handle(a.u, { t: 'afk' }, a.socket);
  assert.equal(a.u.afk, true); assert.equal(a.u.callId, null);
  assert.deepEqual(a.u.tile, a.u.homeDesk); assert.ok(a.u.move);
  a.u.tile = { x: 32, y: 8 }; a.u.move = null; a.u.path = null;
  w.voiceTick(); assert.equal(a.u.callId, null);
  w.handle(a.u, { t: 'active' }, a.socket); w.voiceTick();
  assert.equal(a.u.callId, 'room:coffee');
});

test('afk leaves a knock call, ends a 1:1, notifies the peer without call_moved and suppresses hall voice', t => {
  const { w, add } = setup(t), a = add('Alice Example', { x: 32, y: 8 }), b = add('B');
  w.connectCall(a.u, b.u); b.messages.length = 0;
  w.handle(a.u, { t: 'afk' }, a.socket);
  assert.equal(a.u.callId, null); assert.equal(b.u.callId, null); assert.equal(a.u.afk, true);
  assert.ok(b.messages.some(m => m.t === 'notice' && m.text === 'Alice stepped away from the call'));
  assert.ok(!b.messages.some(m => m.t === 'call_moved'));
  w.voiceTick(); assert.equal(a.u.callId, null);
  w.handle(a.u, { t: 'active' }, a.socket); w.voiceTick(); assert.equal(a.u.callId, 'room:coffee');
});

test('afk leaves a group knock call without ending it', t => {
  const { w, add } = setup(t), a = add('A'), b = add('B'), c = add('C');
  const call = w.connectCall(a.u, b.u); w.connectCall(c.u, b.u);
  w.handle(a.u, { t: 'afk' }, a.socket);
  assert.equal(a.u.callId, null); assert.equal(b.u.callId, call.id); assert.equal(c.u.callId, call.id);
  for (const p of [b, c]) assert.ok(p.messages.some(m => m.t === 'notice' && m.text === 'A stepped away from the call'));
});

test('afk in a meeting instance turns off voice and stays in the meeting', t => {
  const { w, add } = setup(t), a = add('A');
  w.handle(a.u, { t: 'room_create', invite: [] }, a.socket);
  const instance = a.u.instance, tile = { ...a.u.tile };
  assert.ok(instance); assert.equal(a.u.callId, `room:${instance}`);
  w.handle(a.u, { t: 'afk' }, a.socket); w.voiceTick();
  assert.equal(a.u.callId, null); assert.equal(a.u.instance, instance); assert.deepEqual(a.u.tile, tile);
});

test('afk clears a hall waiting line', t => {
  const { w, add } = setup(t);
  for (let i = 0; i < ROOM_VOICE_MAX; i++) add(`Member ${i}`, { x: 32, y: 8 });
  const a = add('Waiting', { x: 33, y: 8 }); w.voiceTick();
  assert.ok(a.messages.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  w.handle(a.u, { t: 'afk' }, a.socket);
  assert.equal(a.u.afk, true); assert.ok(a.messages.some(m => m.t === 'voice_wait' && m.roomId === null));
});

test('afk is owner-only; active from another tab clears afk and relays only to other own sockets; bots ignored', t => {
  const { w, add } = setup(t), a = add('A'), b = add('B');
  w.connectCall(a.u, b.u);
  const other: ServerMsg[] = [], tab = w.connect(a.u.id, m => other.push(m)); w.handle(a.u, { t: 'afk' }, tab.socket); assert.ok(a.u.callId);
  a.u.afk = true; a.messages.length = other.length = b.messages.length = 0;
  w.handle(a.u, { t: 'active' }, tab.socket);
  assert.equal(a.u.afk, false); assert.deepEqual(a.messages, [{ t: 'active' }]); assert.deepEqual(other, []); assert.deepEqual(b.messages, []);
  a.u.bot = true; a.u.afk = true; a.messages.length = 0;
  w.handle(a.u, { t: 'active' }, tab.socket); assert.equal(a.u.afk, true); assert.deepEqual(a.messages, []);
});

test('different tabs retain the owner; same tab reload replaces it; closing the owner hands over', t => {
  const { w, add } = setup(t), a = add('A', undefined, 'tab_a'), peer = add('Peer');
  w.connectCall(a.u, peer.u);
  const second: ServerMsg[] = [], b = w.connect(a.u.id, m => second.push(m), undefined, 'tab_b');
  assert.deepEqual(second.at(-1), { t: 'voice_owner', owner: false });
  w.handle(a.u, { t: 'mute', muted: true }, a.socket); assert.equal(a.u.muted, true);
  const reload: ServerMsg[] = [], c = w.connect(a.u.id, m => reload.push(m), undefined, 'tab_a');
  assert.deepEqual(reload.at(-1), { t: 'voice_owner', owner: true });
  w.handle(a.u, { t: 'mute', muted: false }, a.socket); assert.equal(a.u.muted, true);
  a.close(); c.close(); assert.deepEqual(second.at(-1), { t: 'voice_owner', owner: true });
  w.handle(a.u, { t: 'mute', muted: false }, b.socket); assert.equal(a.u.muted, false);
});

for (const tab of [undefined, '', 'bad tab', 'x'.repeat(41), 123]) test(`invalid or missing tab is unique: ${String(tab)}`, t => {
  const { w, add } = setup(t), a = add('A', undefined, tab as string), b = add('B');
  w.connectCall(a.u, b.u);
  const messages: ServerMsg[] = [];
  w.connect(a.u.id, m => messages.push(m), undefined, tab as string);
  assert.deepEqual(messages.at(-1), { t: 'voice_owner', owner: false });
});

test('knock backstop resets on speaking on and off by any member, then ends everyone after silence', t => {
  const { w, add, tick } = setup(t), a = add('A'), b = add('B');
  const call = w.connectCall(a.u, b.u);
  tick(CALL_SILENCE_MS - 1); w.handle(a.u, { t: 'speaking', on: true }, a.socket);
  tick(CALL_SILENCE_MS - 1); assert.equal(a.u.callId, call.id);
  w.handle(b.u, { t: 'speaking', on: false }, b.socket);
  tick(CALL_SILENCE_MS - 1); assert.equal(b.u.callId, call.id);
  tick(1); assert.equal(a.u.callId, null); assert.equal(b.u.callId, null);
  assert.equal(w['calls'].has(call.id), false); assert.equal(w['callSilenceTimers'].size, 0);
});

test('silent knock call expires and manual dissolution clears its backstop', t => {
  const { w, add, tick } = setup(t), a = add('A'), b = add('B');
  w.connectCall(a.u, b.u); tick(CALL_SILENCE_MS);
  assert.equal(a.u.callId, null); assert.equal(b.u.callId, null);
  w.connectCall(a.u, b.u); w.handle(a.u, { t: 'end_call' }, a.socket);
  assert.equal(w['callSilenceTimers'].size, 0);
});

test('a second tab outside calls takes ownership as before', t => {
  const { w, add } = setup(t), a = add('A', undefined, 'first'), b = add('B');
  const messages: ServerMsg[] = [];
  const second = w.connect(a.u.id, m => messages.push(m), undefined, 'second');
  assert.deepEqual(messages.at(-1), { t: 'voice_owner', owner: true });
  w.connectCall(a.u, b.u); a.messages.length = 0;
  w.handle(a.u, { t: 'deafen', on: true }, a.socket); assert.equal(a.u.deafened, false);
  w.handle(a.u, { t: 'deafen', on: true }, second.socket); assert.equal(a.u.deafened, true);
});
