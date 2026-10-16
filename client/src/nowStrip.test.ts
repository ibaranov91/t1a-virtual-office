import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Store } from './net';
import type { Voice } from './voice';

// SelfPanel imports browser preferences; the helpers themselves need no DOM.
test('room voice eligibility and short/long status stay consistent', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const { roomVoiceOf, roomVoiceStatus } = await import('./sidebar/SelfPanel');
  const room = { id: 'music', name: 'Music' } as NonNullable<ReturnType<Store['roomCallOf']>>;
  const me: { id: string; instance?: string } = { id: 'me' };
  const peers = [
    { name: 'Ivan Baranov', presence: 'online', bot: false },
    { name: 'Kim Lee', presence: 'online', bot: false },
    { name: 'Bot', presence: 'online', bot: true },
    { name: 'Away', presence: 'offline' },
    { name: 'Meeting', presence: 'online', instance: 'meeting' },
  ];
  const store = { me: 'me', users: new Map([['me', me]]), voiceOwner: true,
    roomCallOf: () => room, roomOf: () => room, callPeers: () => peers } as unknown as Store;
  const voice = { inRoomCall: true, onMeet: false, deafened: false, micError: null, muted: false, mode: 'voice', spaceHeld: false } as Voice;
  assert.equal(roomVoiceOf(store, voice), room);
  assert.equal(roomVoiceOf(store, { ...voice, inRoomCall: false } as Voice), null);
  assert.equal(roomVoiceOf(store, null), null);
  store.voiceOwner = false; assert.equal(roomVoiceOf(store, voice), null); store.voiceOwner = true;
  me.instance = 'meeting'; assert.equal(roomVoiceOf(store, voice), null); me.instance = undefined;
  store.roomOf = () => ({ ...room, id: 'coffee' }); assert.equal(roomVoiceOf(store, voice), null); store.roomOf = () => room;
  store.roomCallOf = () => undefined; assert.equal(roomVoiceOf(store, voice), null); store.roomCallOf = () => room;
  store.users.clear(); assert.equal(roomVoiceOf(store, voice), null); store.users.set('me', me as never);

  for (const [patch, state, short, long] of [
    [{}, 'live', 'Live in Music', 'Live in Music · everyone here hears you'],
    [{ muted: true }, 'off', 'Muted in Music', 'Muted in Music · nobody hears you'],
    [{ mode: 'ptt' }, 'ptt', 'Push-to-talk in Music', 'Push-to-talk in Music · hold Space'],
    [{ mode: 'ptt', spaceHeld: true }, 'live', 'Talking in Music', 'Talking in Music'],
    [{ onMeet: true, muted: true }, 'off', 'On Meet', 'On Meet'],
    [{ deafened: true }, 'off', 'Deafened in Music', 'Deafened in Music'],
    [{ micError: 'blocked' }, 'off', 'Listen-only in Music', 'Listen-only in Music'],
  ] as const) {
    const v = { ...voice, ...patch } as Voice;
    const full = roomVoiceStatus(store, v, room, { short: false });
    const brief = roomVoiceStatus(store, v, room, { short: true });
    assert.equal(full.state, state);
    assert.equal(brief.state, state);
    assert.equal(brief.who, 'Ivan, Kim');
    assert.equal(brief.text, `${short} · Ivan, Kim`);
    assert.equal(full.text, `${long} · here: Ivan, Kim`);
    assert.equal(brief.title, full.text);
  }
  store.callPeers = () => [];
  assert.equal(roomVoiceStatus(store, voice, room, { short: true }).text, 'Live in Music · nobody yet');
});
