import { field, hallVoiceGain, reverbImpulse, soundModel } from '../../shared/acoustics';
import { roomAt, type Room, type Tile } from '../../shared/map';
import { audio, categoryOutput, subscribeAudio } from './audio';
import { MAP, type Store } from './net';
import { prefs, subscribePrefs, volumeFor, type Category } from './prefs';
import { playDoorOpen, playDoorClose } from './sounds';
import { roomDoors, type RoomDoor } from './doors';

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
  private buses = new Map<string, { input: ConvolverNode; gate: GainNode; room: Room }>();
  private loading = new Set<string>();
  private previous = new Map<string, Tile>();
  private doors: RoomDoor[] = [];
  private layoutSeen = -1;
  private instance: string | null | undefined;
  doorSounds = { open: 0, close: 0 };
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
    this.resetCrossings();
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
    for (const b of this.buses.values()) { b.input.disconnect(); b.gate.disconnect(); }
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
  private bus(category: Category, room: Room) {
    const key = `${category}:${room.id}`;
    if (!this.buses.has(key)) {
      const c = audio(), impulse = reverbImpulse(room, c.sampleRate);
      const buffer = c.createBuffer(2, impulse[0].length, c.sampleRate);
      buffer.getChannelData(0).set(impulse[0]); buffer.getChannelData(1).set(impulse[1]);
      const input = c.createConvolver(), gate = c.createGain(); gate.gain.value = 0;
      input.buffer = buffer; input.connect(gate).connect(categoryOutput(category));
      this.buses.set(key, { input, gate, room });
    }
    return this.buses.get(key)!.input;
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
      const existing = this.sources.get(id);
      if (existing) { existing.tile = e.tile; existing.clipGain = e.gain; continue; }
      if (this.loading.has(id)) continue;
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
    if (this.layoutSeen !== this.store.layoutVersion) {
      this.layoutSeen = this.store.layoutVersion; this.doors = roomDoors(MAP); this.resetCrossings();
    }
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
      const visible = !me.instance && (!u || u.instance === me.instance);
      const gain = visible ? hall ? hallVoiceGain(MAP, hall, pose, p) : model.gain : 0;
      const send = gain ? model.send : 0;
      const v = s.clipGain * (s.clip ? 1 : volumeFor(id)), mix = prefs.mix[s.category];
      s.level = { id, gain: gain * v * mix, pan: model.pan, cutoff: model.cutoff, send: send * v * mix };
      const sourceRoom = roomAt(MAP, p.tile.x, p.tile.y), bus = sourceRoom ? this.bus(s.category, sourceRoom) : null;
      if (s.bus !== bus) { s.send.disconnect(); if (bus) s.send.connect(bus); s.bus = bus; }
      s.dry.gain.setTargetAtTime(gain * v, c.currentTime, gain ? .08 : .02);
      s.send.gain.setTargetAtTime(send * v, c.currentTime, send ? .08 : .02);
      s.pan.pan.setTargetAtTime(model.pan, c.currentTime, .08);
      s.low.frequency.setTargetAtTime(model.cutoff, c.currentTime, .08);
      if (gain > 0) audible = true;
    }
    for (const b of this.buses.values()) {
      const inside = !me.instance && roomAt(MAP, pose.tile.x, pose.tile.y)?.id === b.room.id;
      b.gate.gain.setTargetAtTime(inside ? 1 : 0, c.currentTime, inside ? .08 : .02);
    }
    if (this.audible !== audible) { this.audible = audible; this.store.changed(); }
    this.crossings();
  }

  resetCrossings(userId?: string) { if (userId) this.previous.delete(userId); else this.previous.clear(); }
  private crossings() {
    const me = this.store.users.get(this.store.me); if (!me) return;
    if (this.instance !== me.instance || !this.store.connected) this.resetCrossings();
    this.instance = me.instance;
    if (me.instance || !this.store.connected) return;
    const pose = this.store.pose(me), next = new Map<string, Tile>();
    for (const u of this.store.users.values()) {
      if (u.presence === 'offline' || u.instance !== me.instance) continue;
      const tile = this.store.pose(u).tile, prev = this.previous.get(u.id); next.set(u.id, { ...tile });
      if (!prev || Math.abs(tile.x - prev.x) + Math.abs(tile.y - prev.y) > 1) continue;
      for (const door of this.doors) {
        const onDoor = (t: Tile) => door.tiles.some(p => p.x === t.x && p.y === t.y);
        const inside = (t: Tile) => roomAt(MAP, t.x, t.y)?.id === door.room.id;
        const enter = onDoor(prev) && inside(tile), exit = inside(prev) && onDoor(tile);
        if (!(enter || exit) || (u.id !== me.id && !inside(pose.tile))) continue;
        const p = audio().createStereoPanner();
        p.pan.value = Math.max(-.35, Math.min(.35, (door.x + door.w / 2 - (pose.x + .5)) / 10));
        p.connect(categoryOutput('effects'));
        if (enter) { playDoorOpen(p); this.doorSounds.open++; }
        else { playDoorClose(p); this.doorSounds.close++; }
        window.setTimeout(() => p.disconnect(), 1000);
      }
    }
    this.previous = next;
  }
}
