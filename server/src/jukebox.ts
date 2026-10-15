import { randomUUID } from 'node:crypto';
import { jukeboxPosition, type Track } from '../../shared/music';
import { JUKEBOX_PER_PERSON, JUKEBOX_QUEUE_MAX, type JukeboxAction, type JukeboxState } from '../../shared/protocol';

type Options = { rand?: () => number; id?: () => string };
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class Jukebox {
  state: JukeboxState;
  history: string[] = [];
  private catalog: Map<string, Track>;
  private rand: () => number;
  private id: () => string;

  constructor(private tracks: Track[], now: number, opts: Options = {}) {
    if (!tracks.length) throw new Error('The jukebox needs at least one track');
    this.catalog = new Map(tracks.map(t => [t.id, t]));
    this.rand = opts.rand ?? Math.random; this.id = opts.id ?? randomUUID;
    const track = tracks[Math.floor(this.rand() * tracks.length)].id;
    this.state = { playId: this.id(), track, by: null, startedAt: now, pausedAt: null, queue: [], last: null };
    this.history = [track];
  }
  private pick() {
    let choices = this.tracks.filter(t => !this.history.includes(t.id) && !this.state.queue.some(e => e.track === t.id));
    if (!choices.length) choices = this.tracks.filter(t => t.id !== this.state.track);
    return (choices.length ? choices : this.tracks)[Math.floor(this.rand() * (choices.length || this.tracks.length))].id;
  }
  private next(now: number) {
    const entry = this.state.queue[0], track = entry?.track ?? this.pick();
    this.state = { playId: this.id(), track, by: entry?.by ?? null, startedAt: now, pausedAt: null,
      queue: this.state.queue.slice(entry ? 1 : 0), last: null };
    this.history = [...this.history, track].slice(-5);
  }
  advance(now: number): boolean {
    if (this.state.pausedAt !== null || now - this.state.startedAt < this.catalog.get(this.state.track)!.duration) return false;
    this.next(now); return true;
  }
  act(userId: string, a: JukeboxAction, now: number): { changed: boolean; notice?: string } {
    const changed = this.advance(now), s = this.state;
    if (a.action === 'queue') {
      if (!this.catalog.has(a.track)) return { changed };
      if (s.track === a.track || s.queue.some(e => e.track === a.track)) return { changed, notice: 'Already in the queue' };
      if (s.queue.filter(e => e.by === userId).length >= JUKEBOX_PER_PERSON) return { changed, notice: `You have ${JUKEBOX_PER_PERSON} tracks queued — wait for one to play` };
      if (s.queue.length >= JUKEBOX_QUEUE_MAX) return { changed, notice: 'The queue is full' };
      this.state = { ...s, queue: [...s.queue, { id: this.id(), track: a.track, by: userId }] };
    } else if (a.action === 'unqueue') {
      const queue = s.queue.filter(e => e.id !== a.entry || e.by !== userId);
      if (queue.length === s.queue.length) return { changed };
      this.state = { ...s, queue };
    } else {
      if (a.playId !== s.playId) return { changed };
      if (a.action === 'pause') {
        if (s.pausedAt !== null) return { changed };
        this.state = { ...s, pausedAt: jukeboxPosition(s, this.catalog.get(s.track)!.duration, now) };
      } else if (a.action === 'play') {
        if (s.pausedAt === null) return { changed };
        this.state = { ...s, startedAt: now - s.pausedAt, pausedAt: null };
      } else this.next(now);
      this.state = { ...this.state, last: { kind: a.action, by: userId, at: now } };
    }
    return { changed: true };
  }
  dump() { return { state: structuredClone(this.state), history: [...this.history] }; }
  static load(tracks: Track[], saved: unknown, now: number, opts?: Options): Jukebox {
    const j = new Jukebox(tracks, now, opts), d = record(saved), s = record(d.state);
    j.history = Array.isArray(d.history) ? d.history.filter((id): id is string => typeof id === 'string' && j.catalog.has(id)).slice(-5) : [];
    const known = typeof s.track === 'string' && j.catalog.has(s.track);
    const track = known ? s.track as string : j.pick(), duration = j.catalog.get(track)!.duration;
    const last = record(s.last);
    j.state = {
      playId: typeof s.playId === 'string' ? s.playId : j.id(), track,
      by: known && typeof s.by === 'string' ? s.by : null,
      startedAt: known && finite(s.startedAt) ? Math.min(s.startedAt, now) : now,
      pausedAt: known && finite(s.pausedAt) ? Math.max(0, Math.min(duration, s.pausedAt)) : null,
      queue: [],
      last: ['pause', 'play', 'skip'].includes(String(last.kind)) && typeof last.by === 'string' && finite(last.at)
        ? { kind: last.kind as 'pause' | 'play' | 'skip', by: last.by, at: last.at } : null,
    };
    const ids = new Set<string>(), queued = new Set<string>(), counts = new Map<string, number>();
    for (const raw of Array.isArray(s.queue) ? s.queue : []) {
      const e = record(raw);
      if (typeof e.id !== 'string' || typeof e.by !== 'string' || typeof e.track !== 'string' || !j.catalog.has(e.track)
        || e.track === track || ids.has(e.id) || queued.has(e.track) || (counts.get(e.by) ?? 0) >= JUKEBOX_PER_PERSON) continue;
      if (j.state.queue.length >= JUKEBOX_QUEUE_MAX) break;
      j.state.queue.push({ id: e.id, by: e.by, track: e.track }); ids.add(e.id); queued.add(e.track); counts.set(e.by, (counts.get(e.by) ?? 0) + 1);
    }
    if (!known) j.history = [...j.history, track].slice(-5);
    return j;
  }
}
