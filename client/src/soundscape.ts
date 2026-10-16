import { NoteClock, type InstrumentKind } from '../../shared/instruments';
import { startVoice, type SynthVoice } from './synth';
import { distanceGain, reverbImpulse, soundModel } from '../../shared/acoustics';
import { roomAt, type MapObject, type Room, type Tile } from '../../shared/map';
import { audio, categoryOutput, rms, subscribeAudio } from './audio';
import { TRACK } from '../../shared/music';
import { currentPlay } from './jukeboxSync';
import { JukeboxPlayer } from './jukeboxPlayer';
import { MAP, type Store } from './net';
import { prefs, subscribePrefs, volumeFor, type Category } from './prefs';
import { playDoorOpen, playDoorClose, playBell, playCoffeeBrew } from './sounds';
import { roomDoors, type RoomDoor } from './doors';

type Level = { id: string; gain: number; pan: number; send: number };
type Jukebox = {
  player: JukeboxPlayer; duck: GainNode; heard: boolean; heardAt: number; warmAt: number; analyser?: AnalyserNode;
  waitingSince?: number; loading: boolean; // heard, should play, silent for a moment: the UI says "Loading…"
};
const LOADING_AFTER = 300; // ms: a start this quick (a prefetched track) doesn't flash the status
const WARM_TILES = 4; // walking this close to the jukebox room's door starts loading it (silently)
/** Whether a walk of at most n steps from `from` reaches one of `targets` (through floor, not walls). */
function within(from: Tile, targets: Tile[], n: number) {
  const walls = MAP.layers.walls, seen = new Set([`${from.x},${from.y}`]); let ring = [from];
  for (let d = 0; d <= n && ring.length; d++) {
    if (ring.some(p => targets.some(t => t.x === p.x && t.y === p.y))) return true;
    const next: Tile[] = [];
    for (const p of ring) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.x + dx, y = p.y + dy, k = `${x},${y}`;
      if (walls[y]?.[x] === 0 && !seen.has(k)) { seen.add(k); next.push({ x, y }); }
    }
    ring = next;
  }
  return false;
}
type PlayingVoice = { by: string; note: number; voice: SynthVoice; at: number };
type Instrument = { kind: InstrumentKind; voices: PlayingVoice[]; held: Map<string, { by: string; until: number }>; lastNoteAt: number; lastActivity: number; analyser?: AnalyserNode };
interface Source {
  kind: 'voice' | 'jukebox' | 'instrument'; jukebox?: Jukebox; instrument?: Instrument; duck?: number; modelGain?: number;
  input: AudioNode; low: BiquadFilterNode; dry: GainNode; pan: StereoPannerNode; send: GainNode;
  bus: ConvolverNode | null; category: 'voice' | 'music'; clipGain: number; tile?: Tile;
  level: Level;
}
export class Soundscape {
  private clocks = new Map<string, NoteClock>();
  private sources = new Map<string, Source>();
  private buses = new Map<string, { input: ConvolverNode; gate: GainNode; room: Room }>();
  private previous = new Map<string, Tile>();
  private doors: RoomDoor[] = [];
  private layoutSeen = -1;
  private instance: string | null | undefined;
  doorSounds = { open: 0, close: 0 };
  coffeeSounds = 0;
  private timer: number;
  private unsub: () => void;
  private unsubPrefs: () => void;
  private unsubStore: () => void;
  private updating = false;
  private offset: number;
  private dead = false;
  audible = false;
  tvRoom: string | null = null; // this listener is watching a live TV in this room

  constructor(private store: Store) {
    store.soundscape = this;
    this.offset = store.offset;
    this.resetCrossings();
    this.unsub = subscribeAudio(() => {
      for (const s of this.sources.values()) s.jukebox?.player.audioChanged();
      this.update(); store.changed();
    });
    this.unsubPrefs = subscribePrefs(() => { this.update(); store.changed(); });
    this.unsubStore = store.subscribe(() => this.update());
    this.timer = window.setInterval(() => this.update(), 100);
    this.update();
    if (import.meta.env?.DEV) Object.assign(window, { __soundscape: this });
  }

  jukebox() {
    return [...this.sources.values()].filter(s => s.kind === 'jukebox').map(s => {
      const id = s.level.id.slice(4), desired = this.store.jukebox[id], j = s.jukebox!;
      return { id, track: desired?.track ?? null, playId: desired?.playId ?? null,
        duck: s.duck ?? 1, ...j.player.debug(), loading: j.loading, rms: j.analyser ? rms(j.analyser) : 0 };
    });
  }
  instruments() {
    return [...this.sources.values()].filter(s => s.instrument).map(s => {
      const i = s.instrument!, id = s.level.id.slice(4);
      return { id, kind: i.kind, player: this.store.instruments[id] ?? null, voices: i.voices.length,
        gain: s.level.gain, lastNoteAt: i.lastNoteAt, rms: i.analyser ? rms(i.analyser) : 0 };
    });
  }
  receiveNote(id: string, by: string, note: number, on: boolean, vel: number, preset: number, at: number) {
    if (this.store.instruments[id] !== by) return;
    let clock = this.clocks.get(by);
    if (!clock) { clock = new NoteClock(); this.clocks.set(by, clock); }
    const time = clock.schedule(at, this.store.now(), on);
    if (time !== null) this.playNote(id, by, note, on, vel, preset, time);
  }
  playNote(id: string, by: string, note: number, on: boolean, vel: number, preset: number, at: number) {
    const s = this.sources.get(`obj:${id}`), i = s?.instrument;
    if (!s || !i) return;
    const now = performance.now(), key = `${by}:${note}`, c = audio();
    const when = c.currentTime + Math.max(0, at - this.store.now()) / 1000;
    i.lastActivity = now;
    if (on) { i.lastNoteAt = now; this.store.lastNote[id] = now; }
    if (i.kind !== 'drums') {
      if (on) i.held.set(key, { by, until: now + Math.max(0, at - this.store.now()) + 10000 });
      else i.held.delete(key);
      for (const v of [...i.voices]) if (v.by === by && v.note === note) {
        if (on) { v.voice.stop(); i.voices.splice(i.voices.indexOf(v), 1); }
        else v.voice.release(when);
      }
    }
    if (!on) return;
    if (i.kind === 'drums' && note === 42) for (const v of i.voices) if (v.note === 46) v.voice.release(when);
    if ((s.modelGain ?? 0) > 0) {
      if (i.voices.length >= 16) i.voices.shift()!.voice.stop();
      const v = { by, note, voice: startVoice(c, s.input, i.kind, preset, note, vel, when), at: when };
      i.voices.push(v);
      void v.voice.done.then(() => { const ix = i.voices.indexOf(v); if (ix >= 0) i.voices.splice(ix, 1); });
    }
  }
  allOff(id: string, by?: string) {
    const i = this.sources.get(`obj:${id}`)?.instrument;
    if (i) {
      for (const v of i.voices) if (!by || v.by === by) v.voice.stop();
      i.voices = i.voices.filter(v => by && v.by !== by);
      for (const [key, h] of i.held) if (!by || h.by === by) i.held.delete(key);
    }
    if (by) this.clocks.delete(by); else this.clocks.clear();
  }
  /** The jukebox should be playing for me but is still loading (or waiting for data). */
  jukeboxLoading(id: string) { return !!this.sources.get(`obj:${id}`)?.jukebox?.loading; }
  levels(): Level[] { return [...this.sources.values()].map(s => ({ ...s.level })); }
  addVoice(id: string, stream: MediaStream) {
    this.remove(id);
    this.add(id, 'voice', audio().createMediaStreamSource(stream), 1);
    this.update();
  }
  remove(id: string) {
    const s = this.sources.get(id); if (!s) return;
    if (s.instrument) { this.allOff(id.slice(4)); s.instrument.analyser?.disconnect(); }
    if (s.kind === 'jukebox') { s.jukebox!.player.destroy(); s.jukebox!.analyser?.disconnect(); }
    s.input.disconnect(); s.low.disconnect(); s.dry.disconnect(); s.pan.disconnect(); s.send.disconnect();
    this.sources.delete(id);
  }
  destroy() {
    this.dead = true; clearInterval(this.timer); this.unsub(); this.unsubPrefs(); this.unsubStore();
    for (const id of [...this.sources.keys()]) this.remove(id);
    for (const b of this.buses.values()) { b.input.disconnect(); b.gate.disconnect(); }
    this.buses.clear();
    if (this.store.soundscape === this) this.store.soundscape = undefined;
  }

  private add(id: string, kind: Source['kind'], input: AudioNode, clipGain: number, tile?: Tile) {
    const c = audio(), low = c.createBiquadFilter(), dry = c.createGain(), pan = c.createStereoPanner(), send = c.createGain();
    low.type = 'lowpass'; low.frequency.value = 20000; dry.gain.value = 0; send.gain.value = 0;
    const category = tile ? 'music' : 'voice';
    input.connect(low); low.connect(dry).connect(pan).connect(categoryOutput(category)); low.connect(send);
    const s: Source = { kind, input, low, dry, pan, send, bus: null, category, clipGain, tile,
      level: { id, gain: 0, pan: 0, send: 0 } };
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
  private emitters() {
    // the jukebox can be moved (edit mode): follow it, and drop one that's gone
    for (const [id, s] of this.sources) if (s.kind === 'jukebox' || s.kind === 'instrument') {
      const o = MAP.objects.find(o => `obj:${o.id}` === id && o.use?.kind === s.kind);
      if (!o) this.remove(id); else if (s.tile!.x !== o.x || s.tile!.y !== o.y) s.tile = { x: o.x, y: o.y };
    }
    for (const o of MAP.objects) if (o.use?.kind === 'jukebox' && !this.sources.has(`obj:${o.id}`)) {
      const duck = audio().createGain(); // ducked while someone plays
      const s = this.add(`obj:${o.id}`, 'jukebox', duck, o.sound?.gain ?? 1, { x: o.x, y: o.y });
      const j: Jukebox = { player: new JukeboxPlayer(duck, () => this.update()), duck, heard: false, heardAt: -Infinity, warmAt: -Infinity, loading: false };
      if (import.meta.env.DEV) { j.analyser = audio().createAnalyser(); j.analyser.fftSize = 2048; s.low.connect(j.analyser); }
      s.jukebox = j;
    }
    for (const o of MAP.objects) if (o.use?.kind === 'instrument' && !this.sources.has(`obj:${o.id}`)) {
      const c = audio(), compressor = c.createDynamicsCompressor();
      compressor.threshold.value = -12; compressor.ratio.value = 4; compressor.attack.value = .003;
      const s = this.add(`obj:${o.id}`, 'instrument', compressor, .8, { x: o.x, y: o.y });
      const i: Instrument = { kind: o.use.instrument, voices: [], held: new Map(), lastNoteAt: -Infinity, lastActivity: -Infinity };
      if (import.meta.env.DEV) { i.analyser = c.createAnalyser(); i.analyser.fftSize = 2048; s.low.connect(i.analyser); }
      s.instrument = i;
    }
  }
  private update() {
    if (this.dead || this.updating) return;
    this.updating = true;
    try {
    this.emitters();
    if (this.layoutSeen !== this.store.layoutVersion) {
      this.layoutSeen = this.store.layoutVersion; this.doors = roomDoors(MAP); this.resetCrossings();
    }
    if (this.offset !== this.store.offset) {
      this.offset = this.store.offset;
      for (const s of this.sources.values()) s.jukebox?.player.resync();
    }
    const now = performance.now();
    for (const s of this.sources.values()) if (s.instrument) {
      const i = s.instrument;
      for (const [key, h] of i.held) if (now >= h.until) {
        i.held.delete(key);
        for (const v of i.voices) if (`${v.by}:${v.note}` === key) v.voice.release(audio().currentTime);
      }
    }
    const me = this.store.users.get(this.store.me);
    if (!me) {
      for (const s of this.sources.values()) s.jukebox?.player.update({ state: undefined, now: this.store.now(), perf: now, warm: false, heard: false });
      if (this.audible) { this.audible = false; this.store.changed(); }
      return;
    }
    const pose = this.store.pose(me), room = this.store.roomCallOf(me), c = audio();
    let audible = false, loadingChanged = false;
    for (const [id, s] of this.sources) {
      const u = this.store.users.get(id), p = s.tile ? { ...s.tile, tile: s.tile } : u ? this.store.pose(u) : null;
      if (!p) continue;
      const hall = s.kind === 'voice' && room && u?.callId === me.callId ? room : undefined;
      const model = soundModel(MAP, pose, p, { room: hall,
        knock: s.kind === 'voice' && !!me.callId && !room && u?.callId === me.callId });
      const visible = me.instance ? s.kind === 'voice' && !!u && u.instance === me.instance : !u || u.instance === me.instance; // in a meeting room you hear only its voices
      const gain = visible ? model.gain : 0;
      const send = gain ? model.send : 0;
      s.modelGain = gain;
      const sourceRoom = roomAt(MAP, p.tile.x, p.tile.y), bus = sourceRoom ? this.bus(s.category, sourceRoom) : null;
      const duck = s.kind === 'jukebox' && sourceRoom && [...this.sources.values()].some(other => other.instrument &&
        roomAt(MAP, other.tile!.x, other.tile!.y)?.id === sourceRoom.id &&
        (other.instrument.held.size > 0 || now - other.instrument.lastActivity < 5000)) ? .25 : 1;
      if (s.kind === 'jukebox' && duck !== (s.duck ?? 1)) s.jukebox!.duck.gain.setTargetAtTime(duck, c.currentTime, duck < 1 ? .1 : .5);
      s.duck = duck;
      const local = s.kind === 'voice' ? volumeFor(id) : s.kind === 'jukebox' ? prefs.jukeboxVolumes[id.slice(4)] ?? 1 : 1;
      const tvMute = s.kind === 'jukebox' && sourceRoom?.id === this.tvRoom;
      const v = s.clipGain * (tvMute ? 0 : local), mix = prefs.mix[s.category];
      s.level = { id, gain: gain * v * mix * duck, pan: model.pan, send: send * v * mix * duck };
      if (s.bus !== bus) { s.send.disconnect(); if (bus) s.send.connect(bus); s.bus = bus; }
      s.dry.gain.setTargetAtTime(gain * v, c.currentTime, gain ? .08 : .02);
      s.send.gain.setTargetAtTime(send * v, c.currentTime, send ? .08 : .02);
      s.pan.pan.setTargetAtTime(model.pan, c.currentTime, .08);
      if (s.kind === 'jukebox') {
        const j = s.jukebox!, state = this.store.connected ? this.store.jukebox[id.slice(4)] : undefined;
        j.heard = gain > 0 && !me.instance;
        if (j.heard) j.heardAt = now;
        // load ahead, silently, for someone on their way in: walking to a spot in the room, or walking right by its door
        const near = !!sourceRoom && pose.walking &&
          within(pose.tile, this.doors.filter(door => door.room.id === sourceRoom.id).flatMap(door => door.tiles), WARM_TILES);
        const destination = me.path?.[me.path.length - 1];
        const heading = !!sourceRoom && pose.walking && !!destination && roomAt(MAP, destination.x, destination.y)?.id === sourceRoom.id;
        const warmNow = this.store.connected && !me.instance && (j.heard || near || heading);
        if (warmNow) j.warmAt = now;
        const serverNow = this.store.now();
        j.player.update({ state, now: serverNow, perf: now, warm: now - j.warmAt < 3000, heard: j.heard });
        const play = currentPlay(state, id => TRACK.get(id)?.duration, serverNow);
        if (j.heard && play && !play.paused && serverNow < play.endsAt) audible = true;
        const waiting = j.heard && j.player.waiting();
        j.waitingSince = waiting ? j.waitingSince ?? now : undefined;
        const loading = waiting && now - j.waitingSince! >= LOADING_AFTER;
        if (loading !== j.loading) { j.loading = loading; loadingChanged = true; }
      } else if (gain > 0) audible = true;
    }
    for (const b of this.buses.values()) {
      const inside = !me.instance && roomAt(MAP, pose.tile.x, pose.tile.y)?.id === b.room.id;
      b.gate.gain.setTargetAtTime(inside ? 1 : 0, c.currentTime, inside ? .08 : .02);
    }
    if (this.audible !== audible || loadingChanged) { this.audible = audible; this.store.changed(); }
    this.crossings();
    } finally { this.updating = false; }
  }

  /** A reception bell rang: heard only by people inside its room, quieter with distance, panned to where it is. */
  ringBell(o: MapObject) {
    const me = this.store.users.get(this.store.me); if (!me || me.instance || !this.store.connected) return;
    const pose = this.store.pose(me), tile = { x: o.x, y: o.y };
    const room = roomAt(MAP, tile.x, tile.y);
    if (!room || roomAt(MAP, pose.tile.x, pose.tile.y)?.id !== room.id) return;
    const model = soundModel(MAP, pose, { x: tile.x, y: tile.y, tile }, {});
    const gain = Math.max(distanceGain(Math.abs(pose.tile.x - tile.x) + Math.abs(pose.tile.y - tile.y)), .08);
    const g = audio().createGain(), p = audio().createStereoPanner();
    g.gain.value = gain; p.pan.value = model.pan;
    g.connect(p).connect(categoryOutput('effects'));
    playBell(g);
    window.setTimeout(() => { g.disconnect(); p.disconnect(); }, 1500);
  }
  /** A coffee was brewed: the brewer and whoever stands in the machine's room (sealed rooms) hear it, panned like the doors. */
  coffeeBrew(o: MapObject, by: string) {
    const me = this.store.users.get(this.store.me); if (!me || me.instance || !this.store.connected) return;
    const pose = this.store.pose(me), room = roomAt(MAP, o.x, o.y);
    if (by !== me.id && (!room || roomAt(MAP, pose.tile.x, pose.tile.y)?.id !== room.id)) return;
    playCoffeeBrew(Math.max(-.35, Math.min(.35, (o.x + o.w / 2 - (pose.x + .5)) / 10)));
    this.coffeeSounds++;
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
        if (!(enter || exit) || u.id !== me.id) continue;
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
