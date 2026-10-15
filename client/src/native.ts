// Bridge to the macOS menu bar app (macos/), which hosts this page in a WKWebView.
// In a normal browser `webkit.messageHandlers.deck` doesn't exist and this is a no-op.
import type { Store } from './net';

type Handler = { postMessage(msg: unknown): void };
const handler = (): Handler | undefined => (window as unknown as { webkit?: { messageHandlers?: { deck?: Handler } } }).webkit?.messageHandlers?.deck;

export const inNativeApp = () => !!handler();

/** Mirror what the menu bar shows (knocks, call, busy) whenever it changes. The knock card's
 *  Later calls `window.__deckNative.reply`; accepting happens in the page so voice starts from a click. */
export function syncNative(store: Store) {
  if (!handler()) return () => {};
  Object.assign(window, { __deckNative: { reply: (knockId: string, reply: 'accept' | 'later') => store.replyKnock(knockId, reply) } });
  let last = '';
  return store.subscribe(() => {
    const me = store.users.get(store.me);
    const state = {
      type: 'state', connected: store.connected,
      inCall: !!me?.callId,
      busy: me?.presence === 'away' || !!me?.callId, // quiet mode: icon only, no knock card
      knocks: store.toasts.filter(t => t.kind === 'knock_in').map(t => ({ id: t.knockId, text: t.text })),
    };
    const key = JSON.stringify(state);
    if (key !== last) { last = key; handler()?.postMessage(state); }
  });
}
