import { TOILET_DRAIN_MS, TOILET_FULL, TOILET_USE_MS, toiletFull, type ToiletState } from '../../shared/protocol';

/** Berghain's stalls. In memory only: a restart leaves them all clean. */
export class Toilets {
  private stalls = new Map<string, ToiletState & { changed: number }>();
  constructor(private onChange: (id: string, state: ToiletState) => void) {}

  state(id: string): ToiletState { const s = this.stalls.get(id); return s ? { fill: s.fill, by: s.by, until: s.until } : { fill: 0, by: null, until: 0 }; }
  snapshot(ids: string[]) { return Object.fromEntries(ids.map(id => [id, this.state(id)])); }
  /** The stall this person is in, if any. */
  occupying(userId: string) { for (const [id, s] of this.stalls) if (s.by === userId) return id; }

  /** Go in, or why not. Each visit counts towards the stall filling up. */
  use(id: string, userId: string, now: number): 'ok' | 'full' | 'busy' {
    const s = this.stalls.get(id) ?? { fill: 0, by: null, until: 0, changed: now };
    if (s.by && s.by !== userId) return 'busy';
    if (toiletFull(s)) return 'full';
    const was = this.occupying(userId); if (was && was !== id) this.leave(userId, now);
    s.by = userId; s.until = now + TOILET_USE_MS; s.fill = Math.min(TOILET_FULL, s.fill + 1); s.changed = now;
    this.stalls.set(id, s); this.emit(id);
    return 'ok';
  }
  /** Walked off (or the time's up): the stall is free again. */
  leave(userId: string, now: number) {
    const id = this.occupying(userId); if (!id) return;
    const s = this.stalls.get(id)!; s.by = null; s.until = 0; s.changed = now; this.emit(id);
  }
  /** An admin with a plunger: clean right away. */
  plunge(id: string, now: number) {
    const s = this.stalls.get(id); if (!s || (!s.fill && !s.by)) return false;
    s.fill = 0; s.changed = now; this.emit(id);
    return true;
  }
  /** Visits end on time, and a stall nobody's in drains one level every TOILET_DRAIN_MS. */
  tick(now: number) {
    for (const [id, s] of this.stalls) {
      if (s.by && now >= s.until) { s.by = null; s.until = 0; s.changed = now; this.emit(id); }
      else if (!s.by && s.fill > 0 && now - s.changed >= TOILET_DRAIN_MS) { s.fill--; s.changed = now; this.emit(id); }
    }
  }
  private emit(id: string) { this.onChange(id, this.state(id)); }
}
