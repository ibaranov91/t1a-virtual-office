// Bridge to the macOS menu bar app (macos/), which hosts this page in a WKWebView.
// In a normal browser `webkit.messageHandlers.deck` doesn't exist and this is a no-op.
import type { Store } from './net';

type Handler = { postMessage(msg: unknown): void };
const handler = (): Handler | undefined => (window as unknown as { webkit?: { messageHandlers?: { deck?: Handler } } }).webkit?.messageHandlers?.deck;

let covered = false;
/** The Mac app says its view is behind other windows: the engine then draws ~2 fps. Always false in a browser. */
export const isCovered = () => covered;

export const inNativeApp = () => !!handler();

/** Mirror what the menu bar shows (knocks, call, busy, unread messages) whenever it changes. The knock card's
 *  Later calls `window.__deckNative.reply`; accepting happens in the page so voice starts from a click.
 *  Clicking the icon with unread messages calls `__deckNative.openChat`. */
export function syncNative(store: Store) {
  if (!handler()) return () => {};
  Object.assign(window, { __deckNative: {
    reply: (knockId: string, reply: 'accept' | 'later') => store.replyKnock(knockId, reply),
    openChat: (withId: string) => store.openChat(withId),
    setCovered: (c: boolean) => { covered = !!c; },
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
      busy: me?.presence === 'away' || !!me?.callId, // quiet mode: icon only, no knock card
      knocks: store.toasts.filter(t => t.kind === 'knock_in').map(t => ({ id: t.knockId, text: t.text })),
      unread: [...store.unread].map(([id, count]) => ({ id, name: store.name(id), count })), // oldest first
    };
    const key = JSON.stringify(state);
    if (key !== last) { last = key; handler()?.postMessage(state); }
  });
}
