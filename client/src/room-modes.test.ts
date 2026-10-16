import { test } from 'node:test';
import assert from 'node:assert/strict';
import mapJson from '../../shared/tilemap.json';
import { roomMode, rulesForMode } from '../../shared/roomModes';
import type { Room } from '../../shared/map';
import { roomGroup } from './sidebar/model';

test('room modes move the same room between sidebar groups and restore its defaults', () => {
  const room = structuredClone(mapJson.rooms.find(r => r.id === 'library')) as Room;
  const base = { ...room.rules };
  for (const [mode, group] of [['voice', 'voice'], ['knock', 'knock'], ['quiet', 'quiet'], ['later', 'quiet']] as const) {
    room.rules = rulesForMode(base, mode);
    assert.equal(roomGroup(room), group);
    assert.equal(roomMode(room), mode);
  }
  room.rules = rulesForMode(base);
  assert.deepEqual(room.rules, base);
  assert.equal(room.rules.occupantLabel, 'reading');
});

test('live room updates invalidate cached floor signs and doors, and reconnect restores defaults', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {} } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const { Store, MAP } = await import('./net');
  const store = new Store('', () => {});
  const receive = (msg: import('../../shared/protocol').ServerMsg) => (store as any).onMessage(msg);
  const before = store.layoutVersion;
  receive({ t: 'room_modes', modes: { focus: 'voice' }, by: 'admin' });
  assert.equal(MAP.rooms.find(r => r.id === 'focus')!.rules.voice, 'open');
  assert.ok(store.layoutVersion > before, 'engine and soundscape must rebuild their cached signs and doors');
  receive({ t: 'state', users: [], objects: {}, serverTime: Date.now() });
  assert.equal(MAP.rooms.find(r => r.id === 'focus')!.rules.voice, undefined);
});
