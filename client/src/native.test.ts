import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from './net';

test('a meeting heads-up reaches the Mac app, and its Later puts it away', async t => {
  const posted: Record<string, unknown>[] = [];
  const win = Object.assign(new EventTarget(), { webkit: { messageHandlers: { deck: { postMessage: (m: Record<string, unknown>) => posted.push(m) } } } });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  t.after(() => { delete (globalThis as { window?: unknown }).window; });
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  const { meetingHeadsUps, syncNative } = await import('./native');
  let listener = () => {};
  const store = {
    connected: false, me: 'a', users: new Map(), unread: new Map(), voiceOwner: false,
    toasts: [
      { id: 1, kind: 'meeting', meetingKey: 'cncr|1', text: '📅 CNCR01. Daily Check In starts at 16:00' },
      { id: 2, kind: 'knock_in', knockId: 'k1', text: 'Kim is knocking' },
      { id: 3, kind: 'info', text: 'Saved' },
    ],
    subscribe: (fn: () => void) => { listener = fn; fn(); return () => {}; },
    dismissMeeting(key: string) { this.toasts = this.toasts.filter(t => t.meetingKey !== key); listener(); },
  };
  syncNative(store as unknown as Store, null);
  assert.deepEqual(posted.at(-1)?.meetings, [{ id: 'cncr|1', text: '📅 CNCR01. Daily Check In starts at 16:00' }]);
  assert.deepEqual(posted.at(-1)?.knocks, [{ id: 'k1', text: 'Kim is knocking' }]);
  (globalThis as unknown as { window: { __deckNative: { dismissMeeting(k: string): void } } }).window.__deckNative.dismissMeeting('cncr|1');
  assert.deepEqual(posted.at(-1)?.meetings, []);
  assert.deepEqual(meetingHeadsUps([{ id: 4, kind: 'meeting', text: 'no key' }]), []);
});
