import { JOURNAL_MAX, type JournalEntry } from '../../shared/protocol';

type NewEntry = Omit<JournalEntry, 'id' | 'at'> & { at?: number };
const clip = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Event journal (engine item 9): a capped list of what happened to each person, newest last in memory, sent only to its owner.
 *  The activity log reads it; later features (thefts, gifts, photos) add their own `kind`s. */
export class Journal {
  private entries = new Map<string, JournalEntry[]>();
  private readAt = new Map<string, number>();
  private seq = 0;
  /** Called after every add, to push the entry to the owner. */
  onAdd: (userId: string, entry: JournalEntry) => void = () => {};

  add(userId: string, e: NewEntry, now = Date.now()): JournalEntry | null {
    const text = clip(e.text, 200), kind = clip(e.kind, 24);
    if (!text || !kind) return null;
    const entry: JournalEntry = { id: `${now.toString(36)}${(this.seq++).toString(36)}`, at: e.at ?? now, kind, text };
    if (e.otherId) entry.otherId = e.otherId;
    if (e.action) entry.action = e.action;
    const list = this.entries.get(userId) ?? [];
    list.push(entry);
    if (list.length > JOURNAL_MAX) list.splice(0, list.length - JOURNAL_MAX);
    this.entries.set(userId, list);
    this.onAdd(userId, entry);
    return entry;
  }
  /** Oldest first. */
  list(userId: string): JournalEntry[] { return this.entries.get(userId) ?? []; }
  readOf(userId: string) { return this.readAt.get(userId) ?? 0; }
  unread(userId: string) { const r = this.readOf(userId); return this.list(userId).filter(e => e.at > r).length; }
  markRead(userId: string, now = Date.now()) { this.readAt.set(userId, now); }

  dump() {
    return Object.fromEntries([...this.entries].map(([id, list]) => [id, { entries: list, readAt: this.readAt.get(id) ?? 0 }]));
  }
  load(data: unknown) {
    this.entries.clear(); this.readAt.clear();
    if (!data || typeof data !== 'object') return;
    for (const [id, v] of Object.entries(data as Record<string, { entries?: unknown; readAt?: unknown }>)) {
      const list = (Array.isArray(v?.entries) ? v.entries : []).filter((e): e is JournalEntry =>
        !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'number' && typeof e.kind === 'string' && typeof e.text === 'string');
      if (list.length) this.entries.set(id, list.slice(-JOURNAL_MAX));
      if (typeof v?.readAt === 'number') this.readAt.set(id, v.readAt);
    }
  }
}
