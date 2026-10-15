import { TOILET_CAPACITY, TOILET_DRAIN_MS, TOILET_FULL, TOILET_SHELF_MAX, TOILET_USE_MS, type ToiletState } from '../../shared/protocol';

interface Stall { fill: number; in: string[]; until: Map<string, number>; queue: string[]; shelf: number; changed: number }
export interface ToiletHooks {
  change(id: string, state: ToiletState): void;
  admit(id: string, userId: string): void;      // first in line, a place came free: they walk in
  refuse(id: string, userIds: string[]): void;  // it overflowed: the line goes home
}

/** Berghain's stalls: a few people inside each, a line outside. In memory only: a restart leaves them all clean. */
export class Toilets {
  private stalls = new Map<string, Stall>();
  constructor(private hooks: ToiletHooks) {}

  state(id: string): ToiletState {
    const s = this.stalls.get(id);
    return s ? { fill: s.fill, in: [...s.in], queue: [...s.queue], shelf: s.shelf } : { fill: 0, in: [], queue: [], shelf: 0 };
  }
  snapshot(ids: string[]) { return Object.fromEntries(ids.map(id => [id, this.state(id)])); }
  /** The stall this person is in, if any. */
  inside(userId: string) { for (const [id, s] of this.stalls) if (s.in.includes(userId)) return id; }
  /** The stall this person is lining up for, and how many are ahead of them. */
  waiting(userId: string) { for (const [id, s] of this.stalls) { const i = s.queue.indexOf(userId); if (i >= 0) return { id, ahead: i }; } }

  /** At the door: go in, line up, or (overflowing) not at all. Each visit counts towards the stall filling up. */
  arrive(id: string, userId: string, now: number): 'in' | 'queued' | 'full' {
    const s = this.stall(id, now);
    if (s.in.includes(userId)) return 'in';
    if (s.fill >= TOILET_FULL) return 'full';
    const other = this.inside(userId) ?? this.waiting(userId)?.id;
    if (other && other !== id) this.leave(userId, now);
    if (s.in.length < TOILET_CAPACITY && (!s.queue.length || s.queue[0] === userId)) {
      if (s.queue[0] === userId) s.queue.shift();
      this.enter(id, s, userId, now);
    } else if (!s.queue.includes(userId)) s.queue.push(userId);
    this.emit(id);
    return s.in.includes(userId) ? 'in' : 'queued';
  }
  /** Out of the stall (walked off, or time's up) or out of the line. The next in line takes the free place. */
  leave(userId: string, now: number) {
    for (const [id, s] of this.stalls) {
      const i = s.in.indexOf(userId), q = s.queue.indexOf(userId);
      if (i < 0 && q < 0) continue;
      if (q >= 0) s.queue.splice(q, 1);
      if (i >= 0) { s.in.splice(i, 1); s.until.delete(userId); s.changed = now; if (!s.in.length) s.shelf = 0; this.promote(id, s, now); }
      this.emit(id);
    }
  }
  /** Rack a line on the shelf: only with company inside. */
  shelf(id: string, userId: string) {
    const s = this.stalls.get(id);
    if (!s || !s.in.includes(userId) || s.in.length < 2 || s.shelf >= TOILET_SHELF_MAX) return false;
    s.shelf++; this.emit(id);
    return true;
  }
  /** Take a line off the shelf. */
  sniff(id: string, userId: string) {
    const s = this.stalls.get(id);
    if (!s || !s.in.includes(userId) || s.shelf <= 0) return false;
    s.shelf--; this.emit(id);
    return true;
  }
  /** Visits end on time, and an empty stall drains one level every TOILET_DRAIN_MS. */
  tick(now: number) {
    for (const [id, s] of this.stalls) {
      for (const [user, until] of s.until) if (now >= until) this.leave(user, now);
      if (!s.in.length && s.fill > 0 && now - s.changed >= TOILET_DRAIN_MS) { s.fill--; s.changed = now; this.promote(id, s, now); this.emit(id); }
    }
  }

  private stall(id: string, now: number) {
    let s = this.stalls.get(id);
    if (!s) this.stalls.set(id, s = { fill: 0, in: [], until: new Map(), queue: [], shelf: 0, changed: now });
    return s;
  }
  private enter(_id: string, s: Stall, userId: string, now: number) {
    s.in.push(userId); s.until.set(userId, now + TOILET_USE_MS); s.fill = Math.min(TOILET_FULL, s.fill + 1); s.changed = now;
  }
  private promote(id: string, s: Stall, now: number) {
    if (s.fill >= TOILET_FULL) {
      if (s.queue.length) { const gone = s.queue.splice(0); this.hooks.refuse(id, gone); }
      return;
    }
    while (s.queue.length && s.in.length < TOILET_CAPACITY && s.fill < TOILET_FULL) {
      const next = s.queue.shift()!;
      this.enter(id, s, next, now);
      this.hooks.admit(id, next);
    }
    if (s.fill >= TOILET_FULL && s.queue.length) this.hooks.refuse(id, s.queue.splice(0));
  }
  private emit(id: string) { this.hooks.change(id, this.state(id)); }
}
