// Bridge to the macOS menu bar app (macos/), which hosts this page in a WKWebView.
// In a normal browser `webkit.messageHandlers.deck` doesn't exist and this is a no-op.
import type { Store } from './net';

type Handler = { postMessage(msg: unknown): void };
const handler = (): Handler | undefined => (window as unknown as { webkit?: { messageHandlers?: { deck?: Handler } } }).webkit?.messageHandlers?.deck;

export const inNativeApp = () => !!handler();

/** Mirror the bits the menu bar icon shows (pending knocks, in a call) whenever they change. */
export function syncNative(store: Store) {
  if (!handler()) return () => {};
  let last = '';
  return store.subscribe(() => {
    const me = store.users.get(store.me);
    const knocks = store.toasts.filter(t => t.kind === 'knock_in').map(t => t.text);
    const state = { type: 'state', connected: store.connected, inCall: !!me?.callId, knocks };
    const key = JSON.stringify(state);
    if (key !== last) { last = key; handler()?.postMessage(state); }
  });
}
