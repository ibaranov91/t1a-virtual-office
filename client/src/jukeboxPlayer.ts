import { TRACK, trackUrl } from '../../shared/music';
import type { JukeboxState } from '../../shared/protocol';
import { audio, forgetMedia, playMedia, unlockOnGesture } from './audio';
import { canTeachLead, clockStep, currentPlay, isAdvancing, learnLead, seekTarget, type Play } from './jukeboxSync';

/**
 * Plays one jukebox in step with the server clock, starting cleanly on any network.
 * - Two decks (an <audio> element each, behind its own gain "gate"): the one playing, and the next track ready on the other.
 *   The server publishes `next`; its file is fetched whole as a Blob while this one plays, loaded paused at 0 and started
 *   `lead` before the boundary, so track changes and skips start at once (WebKit needs ~1 MB before it plays a stream).
 * - A start plays with the gate closed until the element's clock really moves near the server position (silent seeks fix
 *   a stall's leftover), then fades in. Nothing is corrected while the clock stands still: a seek there restarts the wait.
 * - While sounding, a drift beyond LIVE_DRIFT gets one dipped seek; playbackRate is never touched (WebKit stalls on it).
 * - `lead` is this browser's seek latency (WebKit ~0.4 s), learned from clean starts and kept in localStorage.
 */
type Deck = {
  el: HTMLAudioElement; source: MediaElementAudioSourceNode; gate: GainNode;
  url: string | null; objectUrl: string | null; local: boolean; key: string | null;
  phase: 'idle' | 'loading' | 'ready' | 'starting' | 'live'; gen: number; pending: boolean;
  blocked: false | 'quiet' | 'loud'; error: boolean; errorAt: number;
  lastCt: number; lastAt: number; advancingSince: number | null; startAt: number;
  seeks: number; fixes: number; teach: boolean; checkAt: number; loadAt: number; cleanup?: () => void;
};
type Input = { state: JukeboxState | undefined; now: number; perf: number; warm: boolean; heard: boolean };
type Prefetch = { controller: AbortController; blob?: Blob; retryAt?: number };
const duration = (id: string) => TRACK.get(id)?.duration;
const urlFor = (id: string) => trackUrl(TRACK.get(id)!);

export class JukeboxPlayer {
  private decks: Deck[];
  private current: Deck | null = null;
  private input?: Input;
  private play: Play | null = null;
  private lead = 0;
  private trusted = false;
  private cache = new Map<string, Prefetch>();
  private badBlobs = new Set<string>();
  private timers = new Set<number>();
  private boundary?: { timer: number; key: string };
  private dead = false;

  constructor(output: AudioNode, private wake: () => void) {
    try {
      const saved = JSON.parse(localStorage.getItem('deck.jukeboxLead') ?? 'null');
      if (typeof saved?.lead === 'number' && saved.lead >= 0 && saved.lead <= 1) { this.lead = saved.lead; this.trusted = true; }
    } catch { /* storage may be unavailable */ }
    this.decks = Array.from({ length: 2 }, () => {
      const el = new Audio(); el.preload = 'auto'; unlockOnGesture(el);
      const source = audio().createMediaElementSource(el), gate = audio().createGain(); gate.gain.value = 0;
      source.connect(gate).connect(output);
      const d: Deck = { el, source, gate, url: null, objectUrl: null, local: false, key: null, phase: 'idle',
        gen: 0, pending: false, blocked: false, error: false, errorAt: 0, lastCt: 0, lastAt: 0,
        advancingSince: null, startAt: 0, seeks: 0, fixes: 0, teach: false, checkAt: -Infinity, loadAt: 0 };
      el.addEventListener('error', () => {
        if (d.url && el.getAttribute('src') === (d.objectUrl ?? d.url)) this.fail(d);
      });
      return d;
    });
  }

  private later(fn: () => void, ms: number) {
    const timer = window.setTimeout(() => { this.timers.delete(timer); if (!this.dead) fn(); }, ms);
    this.timers.add(timer); return timer;
  }
  private cancelBoundary() {
    if (this.boundary) { clearTimeout(this.boundary.timer); this.timers.delete(this.boundary.timer); this.boundary = undefined; }
  }
  private gate(d: Deck, value: number, tau: number) { d.gate.gain.setTargetAtTime(value, audio().currentTime, tau); }
  private unload(d: Deck) {
    d.gen++; d.cleanup?.(); d.cleanup = undefined;
    d.el.pause(); forgetMedia(d.el); d.gate.gain.cancelScheduledValues(audio().currentTime); d.gate.gain.value = 0;
    if (d.el.getAttribute('src') !== null) { d.el.removeAttribute('src'); d.el.load(); }
    if (d.objectUrl) URL.revokeObjectURL(d.objectUrl);
    d.url = null; d.objectUrl = null; d.local = false; d.key = null; d.phase = 'idle';
    d.pending = false; d.blocked = false; d.error = false; d.teach = false; d.advancingSince = null;
  }
  private fail(d: Deck) {
    const url = d.url;
    if (d.local && url) { this.cache.get(url)?.controller.abort(); this.cache.delete(url); this.badBlobs.add(url); }
    this.unload(d); d.url = url; d.error = true; d.errorAt = performance.now();
    this.later(this.wake, 5000); this.wake();
  }
  private pause(d: Deck) {
    if (d.pending || d.blocked || d.key !== null || !d.el.paused) d.gen++;
    d.pending = false; d.blocked = false; d.el.pause(); forgetMedia(d.el);
    d.gate.gain.cancelScheduledValues(audio().currentTime); d.gate.gain.value = 0; d.key = null;
    if (d.phase === 'starting' || d.phase === 'live') d.phase = 'ready';
  }
  private stop() {
    this.cancelBoundary(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    for (const d of this.decks) this.unload(d);
    for (const entry of this.cache.values()) entry.controller.abort();
    this.cache.clear(); this.badBlobs.clear(); this.current = null; this.play = null;
  }
  private load(d: Deck, url: string, key: string | null) {
    this.unload(d);
    d.url = url; d.key = key; d.phase = 'loading'; d.loadAt = performance.now();
    const blob = !this.badBlobs.has(url) && this.cache.get(url)?.blob;
    if (blob) { d.objectUrl = URL.createObjectURL(blob); d.local = true; }
    const gen = d.gen;
    const metadata = () => { if (gen === d.gen && !this.dead) this.wake(); };
    const ready = () => {
      if (gen !== d.gen || this.dead || d.phase !== 'loading' || d.key !== null) return;
      d.el.pause(); d.el.currentTime = 0; d.phase = 'ready'; this.wake();
    };
    d.el.addEventListener('loadedmetadata', metadata);
    d.el.addEventListener('canplay', ready);
    d.cleanup = () => { d.el.removeEventListener('loadedmetadata', metadata); d.el.removeEventListener('canplay', ready); };
    d.el.src = d.objectUrl ?? url; d.el.load();
  }
  private serverNow(perf = performance.now()) { return this.input!.now + perf - this.input!.perf; }
  private expected(play: Play, now: number) {
    if (play.paused) return play.positionMs / 1000;
    const position = (now - play.startedAt) / 1000;
    return play.predicted ? position : Math.max(0, Math.min(duration(play.track)! / 1000, position));
  }
  private seek(d: Deck, play: Play, now: number, perf: number) {
    const target = seekTarget(this.expected(play, now), this.lead, duration(play.track)! / 1000, d.el.duration);
    const ranges: [number, number][] = Array.from({ length: d.el.buffered.length }, (_, i) => [d.el.buffered.start(i), d.el.buffered.end(i)]);
    d.teach = canTeachLead(ranges, target); d.el.playbackRate = 1; d.el.currentTime = target;
    d.startAt = perf; d.advancingSince = null; d.lastCt = d.el.currentTime; d.lastAt = perf;
  }
  private start(d: Deck, play: Play, now: number, perf: number, heard: boolean) {
    const prepared = d.phase === 'ready' && d.local;
    const gen = ++d.gen; d.key = play.key; d.pending = true; d.blocked = false;
    const target = seekTarget(this.expected(play, now), this.lead, duration(play.track)! / 1000, d.el.duration);
    d.teach = prepared;
    if (Math.abs(d.el.currentTime - target) > .05) this.seek(d, play, now, perf);
    if (prepared) d.teach = true;
    d.startAt = perf; d.lastCt = d.el.currentTime; d.lastAt = perf; d.advancingSince = null;
    d.seeks = 0; d.fixes = 0; d.checkAt = -Infinity; d.phase = 'starting'; d.el.playbackRate = 1;
    const attempt = playMedia(d.el, () => !this.dead && d.gen === gen, !heard);
    // local data starts on time: sound at once. Without a learned lead yet (a new browser), the first settled reading teaches
    // it, and a WebKit browser takes one dipped seek then
    if (prepared) { this.gate(d, 1, .02); d.phase = 'live'; }
    void attempt.then(result => {
      if (this.dead || d.gen !== gen) return;
      d.pending = false;
      if (result === 'blocked') { d.blocked = heard ? 'loud' : 'quiet'; this.gate(d, 0, .01); }
      else if (result === 'error') { this.fail(d); return; }
      this.wake();
    });
  }
  private begin(d: Deck, play: Play, now: number, perf: number, heard: boolean) {
    if (d.phase === 'live' && d.gate.gain.value > 0) {
      const gen = ++d.gen; d.key = play.key; d.pending = true; this.gate(d, 0, .01);
      this.later(() => {
        if (gen !== d.gen) return;
        const at = performance.now(); this.start(d, play, this.serverNow(at), at, this.input!.heard);
      }, 40);
    } else this.start(d, play, now, perf, heard);
  }
  private select(d: Deck) {
    if (d === this.current) return;
    const old = this.current; this.current = d;
    if (!old) return;
    old.key = null;
    const gen = ++old.gen; old.pending = false; old.blocked = false; forgetMedia(old.el);
    // a streamed deck is unloaded, not just paused: WebKit would keep downloading the rest of its file and starve the new one
    const done = () => { if (old.local) this.pause(old); else this.unload(old); };
    if (old.phase === 'live' && old.gate.gain.value > 0) {
      this.gate(old, 0, .01);
      this.later(() => { if (gen === old.gen) done(); }, 60);
    } else done();
  }
  private clock(d: Deck, play: Play, now: number, perf: number) {
    if (d.pending || d.el.paused || d.el.seeking || (d.phase !== 'starting' && d.phase !== 'live')) return;
    if (d.phase === 'live' && perf - d.checkAt < 500) return;
    d.checkAt = perf;
    const advancing = isAdvancing({ ct: d.lastCt, at: d.lastAt }, d.el.currentTime, perf, d.el.playbackRate);
    // after play()/seek, an element short of data is waiting on the network: that drift is a stall, not seek latency
    if (!advancing && d.advancingSince === null && d.el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) d.teach = false;
    d.advancingSince = advancing ? (d.advancingSince ?? d.lastAt) : null;
    d.lastCt = d.el.currentTime; d.lastAt = perf;
    const drift = d.el.currentTime - this.expected(play, now);
    const action = clockStep({ phase: d.phase, advancingMs: d.advancingSince === null ? 0 : perf - d.advancingSince,
      sinceStartMs: perf - d.startAt, drift, trusted: this.trusted, seeks: d.seeks });
    // a third correction in a row learns from its reading whatever teach says, so no browser can keep dipping
    if (action.kind === 'seek' && d.phase === 'live') d.fixes++; else if (action.kind === 'hold') d.fixes = 0;
    if (action.kind !== 'wait' && action.learn && (d.teach || d.fixes >= 3)) {
      this.lead = learnLead(this.lead, drift); this.trusted = true; d.teach = false;
      try { localStorage.setItem('deck.jukeboxLead', JSON.stringify({ lead: this.lead })); } catch { /* storage may be unavailable */ }
    }
    if (action.kind === 'open') { this.gate(d, 1, .05); d.phase = 'live'; }
    else if (action.kind === 'seek') {
      if (d.phase === 'starting') { this.seek(d, play, now, perf); d.seeks++; }
      else {
        const gen = ++d.gen; this.gate(d, 0, .01); d.phase = 'starting'; d.pending = true;
        this.later(() => {
          if (gen !== d.gen) return;
          const at = performance.now(); this.seek(d, play, this.serverNow(at), at); d.seeks++; d.pending = false; this.wake();
        }, 40);
      }
    }
  }
  private prefetch(play: Play, current: Deck | null, perf: number) {
    const url = urlFor(play.track), nextUrl = play.next && TRACK.has(play.next) ? urlFor(play.next) : undefined;
    // keep the next track's file; drop the rest, and the current one's too if it plays from the network (one track that
    // repeats is both, and stays)
    for (const [cached, entry] of this.cache) if (cached !== nextUrl && (cached !== url || (current && !current.local))) {
      entry.controller.abort(); this.cache.delete(cached);
    }
    if (play.predicted || !nextUrl || (!play.paused && current?.phase !== 'live') || this.badBlobs.has(nextUrl)) return;
    let entry = this.cache.get(nextUrl);
    if (entry?.retryAt !== undefined && perf >= entry.retryAt) { this.cache.delete(nextUrl); entry = undefined; }
    if (!entry) {
      entry = { controller: new AbortController() }; this.cache.set(nextUrl, entry);
      const own = entry;
      void fetch(nextUrl, { signal: own.controller.signal }).then(res => {
        if (!res.ok) throw new Error(`Jukebox prefetch: ${res.status}`);
        return res.blob();
      }).then(blob => {
        if (this.dead || this.cache.get(nextUrl) !== own) return;
        own.blob = blob; this.wake();
      }).catch(() => {
        if (this.cache.get(nextUrl) === own) own.retryAt = performance.now() + 5000;
      });
    }
    if (!entry.blob || this.decks.some(d => d !== current && d.url === nextUrl && !d.error)) return;
    const spare = this.decks.find(d => d !== current);
    if (spare && (!spare.error || perf - spare.errorAt >= 5000)) this.load(spare, nextUrl, null);
  }
  private boundaryStart(play: Play, now: number, perf: number, heard: boolean) {
    if (play.predicted || play.paused || !play.next || !TRACK.has(play.next)) { this.cancelBoundary(); return; }
    const key = `${play.next}@${play.endsAt}`;
    if (this.boundary && this.boundary.key !== key) this.cancelBoundary();
    if (this.decks.some(d => d.key === key)) return;
    const next = this.decks.find(d => d.phase === 'ready' && d.url === urlFor(play.next!));
    if (!next) { this.cancelBoundary(); return; }
    const ms = play.endsAt - this.lead * 1000 - now;
    if (ms <= 0) {
      this.cancelBoundary();
      const successor: Play = { key, track: play.next, startedAt: play.endsAt, paused: false,
        positionMs: now - play.endsAt, endsAt: play.endsAt + duration(play.next)!, predicted: true };
      this.start(next, successor, now, perf, heard);
    } else if (ms <= 1000 && !this.boundary) {
      const timer = this.later(() => { this.boundary = undefined; this.wake(); }, ms);
      this.boundary = { timer, key };
    }
  }

  update(input: Input) {
    if (this.dead) return;
    this.input = input;
    const { state, now, perf, warm, heard } = input;
    if (!warm) { this.stop(); return; }
    const play = currentPlay(state, duration, now); this.play = play;
    if (!play) { this.cancelBoundary(); for (const d of this.decks) this.pause(d); return; }
    const url = urlFor(play.track), nextUrl = play.next && TRACK.has(play.next) ? urlFor(play.next) : null;
    const successorKey = nextUrl && !play.paused && !play.predicted ? `${play.next}@${play.endsAt}` : null;
    for (const d of this.decks) {
      if (d !== this.current && d.key && d.key !== play.key && d.key !== successorKey) this.pause(d);
      if (d.error && perf - d.errorAt >= 5000) {
        if (d.url && (d.url === url || d.url === nextUrl)) this.load(d, d.url, null);
        else this.unload(d);
      }
    }
    if (play.paused) {
      this.cancelBoundary();
      for (const d of this.decks) if (d.key || !d.el.paused) this.pause(d);
      this.current = this.decks.find(d => d.url === urlFor(play.track)) ?? null;
      this.prefetch(play, this.current, perf); return;
    }
    let d = this.decks.find(d => d.key === play.key && !d.error);
    if (!d) {
      d = this.decks.find(d => d.url === url && !d.error);
      if (!d) {
        if (this.decks.some(d => d.url === url && d.error && perf - d.errorAt < 5000)) return;
        const available = this.decks.filter(d => !d.error || perf - d.errorAt >= 5000);
        d = available.find(d => d.phase === 'idle' && d.url !== nextUrl)
          ?? available.find(d => d.url !== nextUrl) ?? available[0];
        if (!d) return;
        this.load(d, url, play.key);
      } else {
        this.select(d);
        if (d.el.readyState >= 1) this.begin(d, play, now, perf, heard);
        else d.key = play.key;
      }
    }
    this.select(d);
    if (!d.el.ended || d.key !== play.key) {
      // iOS loads nothing until play(): start a load that brought no metadata within 3 s anyway
      if (d.phase === 'loading' && (d.el.readyState >= 1 || perf - d.loadAt > 3000) && !d.pending) this.start(d, play, now, perf, heard);
      else if (d.blocked === 'quiet' && heard && !d.pending) this.start(d, play, now, perf, heard);
      else if (!d.pending && !d.blocked && d.el.paused && d.phase !== 'loading') this.begin(d, play, now, perf, heard);
      this.clock(d, play, now, perf);
    }
    this.prefetch(play, d, perf);
    this.boundaryStart(play, now, perf, heard);
  }
  /** Should be sounding but isn't: loading, a silent start, or a stream waiting for data. Not when blocked (Enable sound shows). */
  waiting() {
    const play = this.play, d = this.current;
    if (!this.input?.warm || !play || play.paused) return false;
    if (!d) return true;
    if (d.blocked) return false;
    if (d.phase !== 'live') return true;
    return !d.el.paused && d.el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  }
  audioChanged() {
    for (const d of this.decks) {
      if (d.blocked && !d.el.paused) { d.blocked = false; d.key = null; }
      d.checkAt = -Infinity;
    }
  }
  resync() { for (const d of this.decks) d.checkAt = -Infinity; }
  debug() {
    const d = this.current ?? this.decks[0], nextTrack = this.play?.next;
    return { waiting: this.waiting(), active: d.url !== null, paused: d.el.paused, currentTime: d.el.currentTime, src: d.el.getAttribute('src'),
      rate: d.el.playbackRate, lead: this.lead, expected: this.play && this.input ? this.expected(this.play, this.serverNow()) : 0,
      trusted: this.trusted, phase: d.phase, gate: d.gate.gain.value, key: d.key, local: d.local, nextTrack,
      nextReady: !!nextTrack && TRACK.has(nextTrack) && this.decks.some(d => d.phase === 'ready' && d.url === urlFor(nextTrack)),
      prefetch: [...this.cache].map(([url, entry]) => ({ url, done: !!entry.blob })) };
  }
  destroy() {
    this.dead = true; this.stop();
    for (const d of this.decks) { d.source.disconnect(); d.gate.disconnect(); }
  }
}
