import { field, hallLevel, hallVoiceGain, reverbImpulse, soundModel } from '../../shared/acoustics';
import { roomAt, type Room, type Tile } from '../../shared/map';
import { audio, categoryOutput, forgetMedia, playMedia, rms, subscribeAudio, unlockOnGesture } from './audio';
import { TRACK, trackUrl } from '../../shared/music';
import { MAP, type Store } from './net';
import { prefs, subscribePrefs, volumeFor, type Category } from './prefs';
import { playJoin, playLeave } from './sounds';

type Level = { id: string; gain: number; pan: number; cutoff: number; send: number };
type Clip = { buffer: AudioBuffer };
type Jukebox = {
  el: HTMLAudioElement; loadedUrl: string | null; playId: string | null; gen: number;
  heardAt: number; heard: boolean; checkAt: number; pending: boolean; blocked: boolean; error: boolean; errorAt: number;
  lead: number; seekedAt: number; // how far ahead to aim a seek (this browser's seek latency, learned), when we last did
  metadata?: () => void; analyser?: AnalyserNode;
};
interface Source {
  kind: 'voice' | 'clip' | 'jukebox'; jukebox?: Jukebox;
  input: AudioNode; low: BiquadFilterNode; dry: GainNode; pan: StereoPannerNode; send: GainNode;
  bus: ConvolverNode | null; category: 'voice' | 'music'; clipGain: number; tile?: Tile; clip?: Clip; loop?: AudioBufferSourceNode;
  level: Level;
}
const clips = new Map<string, Promise<Clip>>();
function loadClip(name: string) {
  if (!clips.has(name)) clips.set(name, (async () => {
    const res = await fetch(`/assets/sounds/${name}.m4a`);
    if (!res.ok) throw new Error(`Sound ${name}: ${res.status}`);
    return { buffer: await audio().decodeAudioData(await res.arrayBuffer()) };
  })());
  return clips.get(name)!;
}

export class Soundscape {
  private sources = new Map<string, Source>();
  private buses = new Map<string, ConvolverNode>();
  private loading = new Set<string>();
  private admitted = new Map<string, Set<string>>();
  private timer: number;
  private unsub: () => void;
  private unsubPrefs: () => void;
  private unsubStore: () => void;
  private updating = false;
  private running = false;
  private offset: number;
  private dead = false;
  audible = false;

  constructor(private store: Store) {
    store.soundscape = this;
    this.offset = store.offset;
    this.resetAdmitted();
    this.unsub = subscribeAudio(() => {
      const running = audio().state === 'running';
      if (running && !this.running) this.restartLoops();
      this.running = running;
      for (const s of this.sources.values()) if (s.kind === 'jukebox') {
        const j = s.jukebox!; j.checkAt = -Infinity;
        if (j.blocked && !j.el.paused) { j.blocked = false; j.playId = null; }
      }
      this.update(); store.changed();
    });
    this.unsubPrefs = subscribePrefs(() => { this.update(); store.changed(); });
    this.unsubStore = store.subscribe(() => this.update());
    this.running = audio().state === 'running';
    this.timer = window.setInterval(() => this.update(), 100);
    this.update();
    if (import.meta.env?.DEV) Object.assign(window, { __soundscape: this });
  }

  jukebox() {
    return [...this.sources.values()].filter(s => s.kind === 'jukebox').map(s => {
      const id = s.level.id.slice(4), desired = this.store.jukebox[id], j = s.jukebox!;
      return { id, track: desired?.track ?? null, playId: desired?.playId ?? null,
        active: j.loadedUrl !== null, paused: j.el.paused, currentTime: j.el.currentTime,
        expected: this.expected(id), src: j.el.getAttribute('src'), rms: j.analyser ? rms(j.analyser) : 0, lead: j.lead, rate: j.el.playbackRate };
    });
  }
  levels(): Level[] { return [...this.sources.values()].map(s => ({ ...s.level })); }
  addVoice(id: string, stream: MediaStream) {
    this.remove(id);
    this.add(id, 'voice', audio().createMediaStreamSource(stream), 1);
    this.update();
  }
  remove(id: string) {
    const s = this.sources.get(id); if (!s) return;
    s.loop?.stop(); s.loop?.disconnect();
    if (s.kind === 'jukebox') { this.stopJukebox(s.jukebox!, true); s.jukebox!.analyser?.disconnect(); }
    s.input.disconnect(); s.low.disconnect(); s.dry.disconnect(); s.pan.disconnect(); s.send.disconnect();
    this.sources.delete(id);
  }
  destroy() {
    this.dead = true; clearInterval(this.timer); this.unsub(); this.unsubPrefs(); this.unsubStore();
    for (const id of [...this.sources.keys()]) this.remove(id);
    for (const b of this.buses.values()) b.disconnect();
    this.buses.clear();
    if (this.store.soundscape === this) this.store.soundscape = undefined;
  }

  private add(id: string, kind: Source['kind'], input: AudioNode, clipGain: number, tile?: Tile) {
    const c = audio(), low = c.createBiquadFilter(), dry = c.createGain(), pan = c.createStereoPanner(), send = c.createGain();
    low.type = 'lowpass'; low.frequency.value = 20000; dry.gain.value = 0; send.gain.value = 0;
    const category = tile ? 'music' : 'voice';
    input.connect(low); low.connect(dry).connect(pan).connect(categoryOutput(category)); low.connect(send);
    const s: Source = { kind, input, low, dry, pan, send, bus: null, category, clipGain, tile,
      level: { id, gain: 0, pan: 0, cutoff: 20000, send: 0 } };
    this.sources.set(id, s); return s;
  }
  private bus(category: Category, room?: Room) {
    const key = `${category}:${room?.id ?? 'hallway'}`;
    if (!this.buses.has(key)) {
      const c = audio(), impulse = reverbImpulse(room ?? null, c.sampleRate);
      const buffer = c.createBuffer(2, impulse[0].length, c.sampleRate);
      buffer.getChannelData(0).set(impulse[0]); buffer.getChannelData(1).set(impulse[1]);
      const bus = c.createConvolver(); bus.buffer = buffer; bus.connect(categoryOutput(category)); this.buses.set(key, bus);
    }
    return this.buses.get(key)!;
  }
  private startLoop(s: Source) {
    s.loop?.stop(); s.loop?.disconnect();
    const loop = audio().createBufferSource(); loop.buffer = s.clip!.buffer; loop.loop = true;
    loop.connect(s.input);
    const duration = loop.buffer.duration;
    loop.start(0, ((this.store.now() / 1000) % duration + duration) % duration); s.loop = loop;
  }
  private restartLoops() { for (const s of this.sources.values()) if (s.kind === 'clip') this.startLoop(s); }
  private expected(id: string) {
    const desired = this.store.jukebox[id], track = desired && TRACK.get(desired.track);
    return desired && track ? Math.max(0, Math.min(track.duration, desired.pausedAt ?? this.store.now() - desired.startedAt)) / 1000 : 0;
  }
  private stopJukebox(j: Jukebox, unload: boolean) {
    if (!j.el.paused || j.pending || j.blocked || j.metadata || (unload && j.loadedUrl !== null)) j.gen++;
    if (j.metadata) { j.el.removeEventListener('loadedmetadata', j.metadata); j.metadata = undefined; }
    j.el.pause(); forgetMedia(j.el); j.pending = false; j.blocked = false; j.playId = null;
    if (unload && j.loadedUrl !== null) {
      j.el.removeAttribute('src'); j.el.load(); j.loadedUrl = null; j.error = false;
    }
  }
  private reconcile(s: Source, now: number) {
    const j = s.jukebox!, id = s.level.id.slice(4), desired = this.store.connected ? this.store.jukebox[id] : undefined;
    const track = desired && TRACK.get(desired.track), recent = now - j.heardAt < 3000;
    if (!desired || desired.pausedAt !== null || !recent || !track) {
      this.stopJukebox(j, !desired || !recent || !track); return;
    }
    if (this.expected(id) >= track.duration / 1000) { this.stopJukebox(j, false); return; }
    const url = trackUrl(track);
    if (j.error && now - j.errorAt > 5000) this.stopJukebox(j, true); // a failed load or play: start over
    if (j.loadedUrl !== url) {
      this.stopJukebox(j, true);
      const gen = ++j.gen;
      j.metadata = () => {
        if (this.dead || gen !== j.gen) return;
        j.metadata = undefined; this.update();
      };
      j.el.addEventListener('loadedmetadata', j.metadata, { once: true });
      j.loadedUrl = url; j.error = false; j.el.src = url;
      return;
    }
    if (j.el.readyState < HTMLMediaElement.HAVE_METADATA || j.pending || j.error) return;
    if (j.el.paused || j.playId !== desired.playId) {
      if (j.blocked) return;
      this.seek(j, id, now); j.playId = desired.playId;
      const gen = j.gen; j.pending = true;
      void playMedia(j.el, () => !this.dead && gen === j.gen).then(result => {
        if (this.dead || gen !== j.gen) return;
        j.pending = false; j.blocked = result === 'blocked'; j.error = result === 'error'; j.errorAt = performance.now();
        this.update();
      });
    } else if (now - j.checkAt >= 500 && !j.el.seeking && j.el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      j.checkAt = now;
      const drift = j.el.currentTime - this.expected(id);
      if (j.seekedAt) { // first look after a seek: Safari lands ~0.3 s behind, so aim that much ahead next time
        if (now - j.seekedAt < 1000) return;
        j.lead = Math.max(0, Math.min(1, j.lead - drift)); j.seekedAt = 0;
      }
      if (Math.abs(drift) > .3) this.seek(j, id, now);
      // close the rest by playing a touch faster or slower (seeks are audible)
      else j.el.playbackRate = Math.abs(drift) < .03 ? 1 : 1 - Math.max(-.05, Math.min(.05, drift * .25));
    }
  }
  private seek(j: Jukebox, id: string, now: number) {
    const track = TRACK.get(this.store.jukebox[id]?.track ?? '');
    j.el.playbackRate = 1; j.el.currentTime = Math.min(this.expected(id) + j.lead, (track?.duration ?? 0) / 1000); j.seekedAt = now; j.checkAt = now;
  }
  private emitters() {
    // the jukebox can be moved (edit mode): follow it, and drop one that's gone
    for (const [id, s] of this.sources) if (s.kind === 'jukebox') {
      const o = MAP.objects.find(o => `obj:${o.id}` === id && o.use?.kind === 'jukebox');
      if (!o) this.remove(id); else if (s.tile!.x !== o.x || s.tile!.y !== o.y) s.tile = { x: o.x, y: o.y };
    }
    for (const o of MAP.objects) if (o.use?.kind === 'jukebox' && !this.sources.has(`obj:${o.id}`)) {
      const el = new Audio(); el.preload = 'auto'; unlockOnGesture(el);
      const s = this.add(`obj:${o.id}`, 'jukebox', audio().createMediaElementSource(el), o.sound?.gain ?? 1, { x: o.x, y: o.y });
      const j: Jukebox = { el, loadedUrl: null, playId: null, gen: 0, heardAt: -Infinity, heard: false,
        checkAt: -Infinity, pending: false, blocked: false, error: false, errorAt: 0, lead: 0, seekedAt: 0 };
      el.addEventListener('error', () => { if (j.loadedUrl && el.getAttribute('src') === j.loadedUrl) { j.error = true; j.errorAt = performance.now(); } });
      if (import.meta.env.DEV) { j.analyser = audio().createAnalyser(); j.analyser.fftSize = 2048; s.low.connect(j.analyser); }
      s.jukebox = j;
    }
    const wanted = new Map<string, { clip: string; gain: number; tile?: Tile }>();
    for (const o of MAP.objects) if (o.sound?.clip) wanted.set(`obj:${o.id}`, { clip: o.sound.clip, gain: o.sound.gain, tile: { x: o.x, y: o.y } });
    for (const [id, s] of this.sources) if (s.kind === 'clip' && !wanted.has(id)) this.remove(id);
    for (const [id, e] of wanted) {
      if (this.sources.has(id) || this.loading.has(id)) continue;
      this.loading.add(id);
      void loadClip(e.clip).then(clip => {
        this.loading.delete(id);
        if (this.dead) return;
        const s = this.add(id, 'clip', audio().createGain(), e.gain, e.tile); s.clip = clip;
        this.startLoop(s); this.update();
      }).catch(err => console.warn('soundscape clip', err));
    }
  }
  private update() {
    if (this.dead || this.updating) return;
    this.updating = true;
    try {
    this.emitters();
    if (this.offset !== this.store.offset) {
      if (Math.abs(this.offset - this.store.offset) > 250) this.restartLoops();
      this.offset = this.store.offset;
      for (const s of this.sources.values()) if (s.kind === 'jukebox') s.jukebox!.checkAt = -Infinity;
    }
    const me = this.store.users.get(this.store.me);
    if (!me) {
      for (const s of this.sources.values()) if (s.kind === 'jukebox') this.stopJukebox(s.jukebox!, true);
      if (this.audible) { this.audible = false; this.store.changed(); }
      return;
    }
    const pose = this.store.pose(me), distances = field(MAP, pose.tile), room = this.store.roomCallOf(me), c = audio();
    let audible = false;
    for (const [id, s] of this.sources) {
      const u = this.store.users.get(id), p = s.tile ? { ...s.tile, tile: s.tile } : u ? this.store.pose(u) : null;
      if (!p) continue;
      const hall = s.kind === 'voice' && room && u?.callId === me.callId ? room : undefined;
      const model = soundModel(MAP, distances, pose, p, { room: hall, sourceMember: !!hall,
        knock: s.kind === 'voice' && !!me.callId && !room && u?.callId === me.callId });
      const zone = hall ? hallLevel(MAP, hall, pose.tile) * hallLevel(MAP, hall, p.tile) : 1;
      const gain = hall ? hallVoiceGain(MAP, hall, pose, p) : model.gain;
      const v = s.clipGain * (s.kind === 'voice' ? volumeFor(id) : 1), mix = prefs.mix[s.category];
      s.level = { id, gain: gain * v * mix, pan: model.pan, cutoff: model.cutoff, send: model.send * zone * v * mix };
      const bus = this.bus(s.category, roomAt(MAP, p.tile.x, p.tile.y));
      if (s.bus !== bus) { s.send.disconnect(); s.send.connect(bus); s.bus = bus; }
      s.dry.gain.setTargetAtTime(gain * v, c.currentTime, .08);
      s.send.gain.setTargetAtTime(model.send * zone * v, c.currentTime, .08);
      s.pan.pan.setTargetAtTime(model.pan, c.currentTime, .08);
      s.low.frequency.setTargetAtTime(model.cutoff, c.currentTime, .08);
      if (s.kind === 'jukebox') {
        const j = s.jukebox!, desired = this.store.jukebox[id.slice(4)], track = desired && TRACK.get(desired.track);
        j.heard = gain > 0 && !me.instance;
        if (j.heard) j.heardAt = performance.now();
        this.reconcile(s, performance.now());
        if (j.heard && this.store.connected && desired?.pausedAt === null && track && this.expected(id.slice(4)) < track.duration / 1000) audible = true;
      } else if (gain > 0) audible = true;
    }
    if (this.audible !== audible) { this.audible = audible; this.store.changed(); }
    this.crossings();
    } finally { this.updating = false; }
  }

  resetAdmitted() {
    this.admitted.clear();
    for (const r of MAP.rooms.filter(r => r.rules.voice === 'open')) {
      this.admitted.set(r.id, new Set([...this.store.users.values()].filter(u => u.callId === `room:${r.id}` && this.store.roomOf(u)?.id === r.id).map(u => u.id)));
    }
  }
  private crossings() {
    const me = this.store.users.get(this.store.me), room = this.store.roomCallOf(me);
    const hear = me && room && this.store.roomOf(me)?.id === room.id;
    for (const r of MAP.rooms.filter(r => r.rules.voice === 'open')) {
      const set = this.admitted.get(r.id) ?? new Set<string>(); this.admitted.set(r.id, set);
      for (const id of [...set]) {
        const u = this.store.users.get(id);
        if (!u || u.presence === 'offline' || this.store.roomOf(u)?.id !== r.id) {
          set.delete(id); if (hear && room.id === r.id) this.atDoor(r, playLeave);
        }
      }
      for (const u of this.store.users.values()) {
        if (u.callId !== `room:${r.id}` || u.presence === 'offline' || this.store.roomOf(u)?.id !== r.id || set.has(u.id)) continue;
        set.add(u.id); if (hear && room.id === r.id) this.atDoor(r, playJoin);
      }
    }
  }
  private atDoor(room: Room, play: (dest: AudioNode) => void) {
    const me = this.store.users.get(this.store.me); if (!me) return;
    const { x, y, w, h } = room.rect;
    const candidates: Tile[] = [];
    for (let xx = x; xx < x + w; xx++) candidates.push({ x: xx, y: y - 1 }, { x: xx, y: y + h });
    for (let yy = y; yy < y + h; yy++) candidates.push({ x: x - 1, y: yy }, { x: x + w, y: yy });
    const tile = candidates.find(t => MAP.layers.walls[t.y]?.[t.x] === 0 && !roomAt(MAP, t.x, t.y));
    if (!tile) return;
    const pose = this.store.pose(me), p = audio().createStereoPanner();
    p.pan.value = soundModel(MAP, field(MAP, pose.tile), pose, { ...tile, tile }).pan;
    p.connect(categoryOutput('effects')); play(p); window.setTimeout(() => p.disconnect(), 1000);
  }
}
