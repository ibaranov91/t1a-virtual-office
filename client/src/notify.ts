// Notification center (v2 engine item 8): the pure rules. The Store keeps the queue; App.tsx draws the slots.
// Slots: top = what is happening to you now; bottom = a mode you are in, with its exit; over = brief one-off notices
// over your own character. Whatever leaves a slot goes to the activity log (docs/UI.md "Notifications").
import type { JournalEntry } from '../../shared/protocol';

export type Slot = 'top' | 'bottom' | 'over';

/** Most pop-ups in the top slot at once; extra low-priority ones fall off the oldest first. */
export const TOP_MAX = 4;
/** Incoming knocks shown as pop-ups. Older ones are answered "Later" and live in the activity log. */
export const KNOCK_POPUPS_MAX = 2;
/** One-off notices over the character at once (the oldest leaves first). */
export const OVER_MAX = 3;
/** Default lifetime of a one-off notice. */
export const OVER_MS = 4500;
/** Notices that left a slot and are kept in this page's activity log (the server's journal holds the rest). */
export const LOCAL_LOG_MAX = 100;

export interface Queued { id: number; kind: string; slot?: Slot; knockId?: string; log?: boolean }

/** Kinds the server already writes to the journal (knocks): the client never logs them a second time. */
const SERVER_LOGGED = new Set(['knock_in', 'knock_out', 'knock_again']);
/** Kinds that are chatter or progress, not events: they leave without a trace. */
const NO_LOG = new Set(['knock_out', 'chat', 'meeting']);
const PRIORITY: Record<string, number> = { knock_in: 5, meeting: 4, link: 3, call_moved: 3, achievement: 2, knock_again: 2, knock_out: 2, chat: 1, info: 1 };

export const slotOf = (t: Pick<Queued, 'kind' | 'slot'>): Slot => t.slot ?? 'top';
export const priorityOf = (t: Pick<Queued, 'kind'>) => PRIORITY[t.kind] ?? 1;
/** Does a notice that left its slot get a line in the activity log? */
export const logsOnExit = (t: Pick<Queued, 'kind' | 'log'>) => t.log ?? (!SERVER_LOGGED.has(t.kind) && !NO_LOG.has(t.kind));

/** Incoming knock pop-ups beyond the newest KNOCK_POPUPS_MAX (oldest first): the caller answers them "Later". */
export function knockOverflow<T extends Queued>(queue: T[]): T[] {
  const knocks = queue.filter(t => t.kind === 'knock_in' && t.knockId);
  return knocks.slice(0, Math.max(0, knocks.length - KNOCK_POPUPS_MAX));
}

/** What to drop so each slot fits. Top never drops a pending knock (that is `knockOverflow`'s job); the lowest priority, then oldest, goes first. */
export function overflow<T extends Queued>(queue: T[]): T[] {
  const drop: T[] = [];
  const over = queue.filter(t => slotOf(t) === 'over');
  drop.push(...over.slice(0, Math.max(0, over.length - OVER_MAX)));
  const top = queue.filter(t => slotOf(t) === 'top');
  let extra = top.length - TOP_MAX;
  if (extra > 0) {
    const order = top.filter(t => t.kind !== 'knock_in').sort((a, b) => priorityOf(a) - priorityOf(b) || a.id - b.id);
    drop.push(...order.slice(0, extra));
  }
  return drop;
}

/** A line for the activity log from a notice that has left its slot. Session-only, `c`-prefixed ids. */
export function localEntry(seq: number, text: string, at: number): JournalEntry {
  return { id: `c${seq}`, at, kind: 'notice', text };
}

/** Server journal plus this page's own entries, newest first. */
export function mergeLog(server: JournalEntry[], local: JournalEntry[]): JournalEntry[] {
  return [...server, ...local].sort((a, b) => b.at - a.at);
}

/** Entries newer than the read marker. */
export const unreadCount = (entries: JournalEntry[], readAt: number) => entries.filter(e => e.at > readAt).length;

/** A mode you are in (bottom slot): what it is and how to leave. `id` is stable, so setting it again updates it. */
export interface Mode { id: string; icon?: string; text: string; hint?: string; exit: { label: string; run: () => void }; actions?: { label: string; run: () => void }[] }
