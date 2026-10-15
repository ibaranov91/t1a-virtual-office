import { field, hallLevel, hallVoiceGain, reverbImpulse, soundModel } from '../../shared/acoustics';
import { roomAt, type Room, type Tile } from '../../shared/map';
import { audio, categoryOutput, subscribeAudio } from './audio';
import { MAP, type Store } from './net';
import { prefs, subscribePrefs, volumeFor, type Category } from './prefs';
import { playJoin, playLeave } from './sounds';

type Level = { id: string; gain: number; pan: number; cutoff: number; send: number };
type Clip = { buffer: AudioBuffer };
interface Source {
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
      this.running = running; store.changed();
    });
    this.unsubPrefs = subscribePrefs(() => { this.update(); store.changed(); });
    this.running = audio().state === 'running';
    this.timer = window.setInterval(() => this.update(), 100);
    this.update();
    if (import.meta.env?.DEV) Object.assign(window, { __soundscape: this });
  }

  levels(): Level[] { return [...this.sources.values()].map(s => ({ ...s.level })); }
  addVoice(id: string, stream: MediaStream) {
    this.remove(id);
    this.add(id, audio().createMediaStreamSource(stream), 1);
    this.update();
  }
  remove(id: string) {
    const s = this.sources.get(id); if (!s) return;
    s.loop?.stop(); s.loop?.disconnect();
    s.input.disconnect(); s.low.disconnect(); s.dry.disconnect(); s.pan.disconnect(); s.send.disconnect();
    this.sources.delete(id);
  }
  destroy() {
    this.dead = true; clearInterval(this.timer); this.unsub(); this.unsubPrefs();
    for (const id of [...this.sources.keys()]) this.remove(id);
    for (const b of this.buses.values()) b.disconnect();
    this.buses.clear();
    if (this.store.soundscape === this) this.store.soundscape = undefined;
  }

  private add(id: string, input: AudioNode, clipGain: number, tile?: Tile) {
    const c = audio(), low = c.createBiquadFilter(), dry = c.createGain(), pan = c.createStereoPanner(), send = c.createGain();
    low.type = 'lowpass'; low.frequency.value = 20000; dry.gain.value = 0; send.gain.value = 0;
    const category = tile ? 'music' : 'voice';
    input.connect(low); low.connect(dry).connect(pan).connect(categoryOutput(category)); low.connect(send);
    const s: Source = { input, low, dry, pan, send, bus: null, category, clipGain, tile,
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
  private restartLoops() { for (const s of this.sources.values()) if (s.clip) this.startLoop(s); }
  private emitters() {
    const wanted = new Map<string, { clip: string; gain: number; tile?: Tile }>();
    for (const o of MAP.objects) if (o.sound) wanted.set(`obj:${o.id}`, { ...o.sound, tile: { x: o.x, y: o.y } });
    for (const [id, s] of this.sources) if (s.clip && !wanted.has(id)) this.remove(id);
    for (const [id, e] of wanted) {
      if (this.sources.has(id) || this.loading.has(id)) continue;
      this.loading.add(id);
      void loadClip(e.clip).then(clip => {
        this.loading.delete(id);
        if (this.dead) return;
        const s = this.add(id, audio().createGain(), e.gain, e.tile); s.clip = clip;
        this.startLoop(s); this.update();
      }).catch(err => console.warn('soundscape clip', err));
    }
  }
  private update() {
    if (this.dead) return;
    this.emitters();
    if (Math.abs(this.offset - this.store.offset) > 250) { this.offset = this.store.offset; this.restartLoops(); }
    const me = this.store.users.get(this.store.me);
    if (!me) return;
    const pose = this.store.pose(me), distances = field(MAP, pose.tile), room = this.store.roomCallOf(me), c = audio();
    let audible = false;
    for (const [id, s] of this.sources) {
      const u = this.store.users.get(id), p = s.tile ? { ...s.tile, tile: s.tile } : u ? this.store.pose(u) : null;
      if (!p) continue;
      const hall = !s.clip && room && u?.callId === me.callId ? room : undefined;
      const model = soundModel(MAP, distances, pose, p, { room: hall, sourceMember: !!hall,
        knock: !s.clip && !!me.callId && !room && u?.callId === me.callId });
      const zone = hall ? hallLevel(MAP, hall, pose.tile) * hallLevel(MAP, hall, p.tile) : 1;
      const gain = hall ? hallVoiceGain(MAP, hall, pose, p) : model.gain;
      const v = s.clipGain * (s.clip ? 1 : volumeFor(id)), mix = prefs.mix[s.category];
      s.level = { id, gain: gain * v * mix, pan: model.pan, cutoff: model.cutoff, send: model.send * zone * v * mix };
      const bus = this.bus(s.category, roomAt(MAP, p.tile.x, p.tile.y));
      if (s.bus !== bus) { s.send.disconnect(); s.send.connect(bus); s.bus = bus; }
      s.dry.gain.setTargetAtTime(gain * v, c.currentTime, .08);
      s.send.gain.setTargetAtTime(model.send * zone * v, c.currentTime, .08);
      s.pan.pan.setTargetAtTime(model.pan, c.currentTime, .08);
      s.low.frequency.setTargetAtTime(model.cutoff, c.currentTime, .08);
      if (gain > 0) audible = true;
    }
    if (this.audible !== audible) { this.audible = audible; this.store.changed(); }
    this.crossings();
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
