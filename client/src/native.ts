// Bridge to the macOS menu bar app (macos/), which hosts this page in a WKWebView.
// In a normal browser `webkit.messageHandlers.deck` doesn't exist and this is a no-op.
import type { Store } from './net';
import type { WellnessRequest } from './wellness';
import type { Voice } from './voice';
import { prefs } from './prefs';

type Handler = { postMessage(msg: unknown): void };
const handler = (): Handler | undefined => (window as unknown as { webkit?: { messageHandlers?: { deck?: Handler } } }).webkit?.messageHandlers?.deck;

let covered = false;

/** The meeting heads-ups on screen, for the Mac app's card (id = the meeting's key). */
export const meetingHeadsUps = (toasts: Store['toasts']) =>
  toasts.filter(t => t.kind === 'meeting' && t.meetingKey).map(t => ({ id: t.meetingKey!, text: t.text }));
/** The Mac app says its view is behind other windows: the engine then draws ~2 fps. Always false in a browser. */
export const isCovered = () => covered;

export const inNativeApp = () => !!handler();
export const syncWellnessNative = (owner: string, requests: WellnessRequest[]) => handler()?.postMessage({ type: 'wellness', owner, requests });
export const requestWellnessPermission = () => handler()?.postMessage({ type: 'wellnessPermission' });
export const openNotificationSettings = () => handler()?.postMessage({ type: 'wellnessSettings' });

/** Mirror what the menu bar shows (knocks, meeting heads-ups, call, mute/deafen, busy, unread messages) whenever it changes.
 *  The knock card's Later calls `window.__deckNative.reply`, the meeting card's `dismissMeeting`; accepting and Go happen in
 *  the page so voice starts from a click. Without this a heads-up only lived in the page, unseen behind a closed popover.
 *  Clicking the icon with unread messages calls `__deckNative.openChat`. */
export function syncNative(store: Store, voice: Voice | null) {
  if (!handler()) return () => {};
  Object.assign(window, { __deckNative: {
    reply: (knockId: string, reply: 'accept' | 'later') => store.replyKnock(knockId, reply),
    dismissMeeting: (key: string) => store.dismissMeeting(key),
    openChat: (withId: string) => store.openChat(withId),
    setCovered: (c: boolean) => { covered = !!c; },
    openWellness: (kind: string) => { if (kind === 'water' || kind === 'stretch' || kind === 'pomodoro') store.openWellness(kind); },
    wellnessPermission: (status: string) => window.dispatchEvent(new CustomEvent('deck:wellness-permission', { detail: status })),
    wake: () => store.reconnectNow(), // the app saw the network come back or the Mac wake up
  } });
  // The app compares this with its own build and updates itself. Asked on every (re)connect: a deploy
  // that only changes the Mac app restarts the server without reloading this page.
  const checkMacApp = () => fetch('/api/mac').then(r => (r.ok ? r.json() : null))
    .then(m => m && handler()?.postMessage({ type: 'macApp', ...m })).catch(() => {});
  let last = '', wasConnected = false;
  return store.subscribe(() => {
    if (store.connected && !wasConnected) void checkMacApp();
    wasConnected = store.connected;
    const me = store.users.get(store.me);
    const state = {
      type: 'state', connected: store.connected,
      inCall: !!me?.callId,
      // the same states as the mic and speaker buttons (VoiceIcons in App.tsx)
      mic: !store.connected || !store.voiceOwner ? 'off' : !me?.callId ? 'idle' : voice?.micError ? 'err' : (voice?.muted ?? true) || (voice?.deafened ?? prefs.deafened) ? 'muted' : 'live', // deafened silences the mic too
      speaker: !store.connected || !store.voiceOwner ? 'off' : (voice?.deafened ?? prefs.deafened) ? 'deafened' : 'live',
      busy: me?.presence === 'away' || !!me?.callId || !!me?.vacation, // quiet mode: icon only, no knock card
      knocks: store.toasts.filter(t => t.kind === 'knock_in').map(t => ({ id: t.knockId, text: t.text })),
      meetings: meetingHeadsUps(store.toasts),
      unread: [...store.unread].map(([id, count]) => ({ id, name: store.name(id), count })), // oldest first
    };
    const key = JSON.stringify(state);
    if (key !== last) { last = key; handler()?.postMessage(state); }
  });
}
