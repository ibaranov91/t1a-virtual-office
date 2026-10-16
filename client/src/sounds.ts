// Tiny synthesized UI sounds (no audio files). Meant to be noticed, not to startle:
// short, low, quiet, and never repeating on their own.

import { audio, categoryOutput } from './audio';

function tone(c: AudioContext, dest: AudioNode, at: number, o: { hz: number; to?: number; glide?: number; level: number; attack: number; decay: number; type?: OscillatorType }) {
  const osc = c.createOscillator(), gain = c.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(o.level, at + o.attack);
  gain.gain.exponentialRampToValueAtTime(.0001, at + o.decay);
  osc.type = o.type ?? 'sine'; osc.frequency.setValueAtTime(o.hz, at);
  if (o.to !== undefined && o.to !== o.hz) osc.frequency.exponentialRampToValueAtTime(o.to, at + (o.glide ?? o.decay));
  osc.connect(gain).connect(dest); osc.start(at); osc.stop(at + o.decay + .02);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}

/** One soft knuckle tap on wood: a low body thump plus a filtered click, decaying in ~0.1 s. */
function tap(c: AudioContext, at: number, pitch: number, level: number, dest: AudioNode) {
  const out = c.createGain();
  out.gain.setValueAtTime(0, at);
  out.gain.linearRampToValueAtTime(level, at + 0.004);
  out.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1400;
  out.connect(lp).connect(dest);
  const cleanup = () => { out.disconnect(); lp.disconnect(); };

  // body: a quick downward-bending sine
  const body = c.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(pitch, at);
  body.frequency.exponentialRampToValueAtTime(pitch * 0.6, at + 0.1);
  body.connect(out);
  body.start(at); body.stop(at + 0.14);
  body.onended = () => { body.disconnect(); cleanup(); };

  // click: a few ms of band-passed noise for the "wood" texture
  const len = Math.floor(c.sampleRate * 0.02);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const noise = c.createBufferSource();
  noise.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.2;
  const ng = c.createGain(); ng.gain.value = 0.35;
  noise.connect(bp).connect(ng).connect(out);
  noise.start(at);
  noise.onended = () => { noise.disconnect(); bp.disconnect(); ng.disconnect(); };
}

/** "tok-tok": two gentle knocks, the second a touch softer and lower. */
export function playKnock() {
  const dest = categoryOutput('effects');
  try {
    const c = audio();
    const t = c.currentTime + 0.02;
    tap(c, t, 210, 0.16, dest);
    tap(c, t + 0.16, 190, 0.12, dest);
  } catch { /* audio unavailable: stay silent */ }
}

/** A soft bubbly "pop" for a reaction or a message: one short rising sine. */
export function playPop() {
  try {
    const c = audio(), at = c.currentTime + 0.01;
    tone(c, categoryOutput('effects'), at, { hz: 520, to: 880, glide: .08, level: .09, attack: .01, decay: .16 });
  } catch { /* audio unavailable: stay silent */ }
}

/** A cat's purr (a low, wobbling rumble) or a dog's yip (two quick rising chirps). */
export function playPet(dog: boolean) {
  try {
    const c = audio(), at = c.currentTime + 0.01, out = categoryOutput('effects');
    const blip = (t0: number, f0: number, f1: number, len: number, vol: number, type: OscillatorType) => {
      const g = c.createGain(), o = c.createOscillator();
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + len * 0.8);
      o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + len + 0.02);
      o.onended = () => { o.disconnect(); g.disconnect(); };
      return o;
    };
    if (dog) { blip(at, 520, 900, 0.1, 0.1, 'triangle'); blip(at + 0.14, 600, 1050, 0.12, 0.1, 'triangle'); return; }
    const o = blip(at, 38, 34, 1.1, 0.16, 'sawtooth'); // purr: a rumble with a 25 Hz flutter
    const lfo = c.createOscillator(), depth = c.createGain();
    lfo.frequency.value = 25; depth.gain.value = 12; lfo.connect(depth); depth.connect(o.frequency); lfo.start(at); lfo.stop(at + 1.15);
    blip(at, 110, 90, 1.0, 0.04, 'sine');
  } catch { /* audio unavailable: stay silent */ }
}

export function playDoorOpen(dest: AudioNode = categoryOutput('effects')) {
  const c = audio(), at = c.currentTime + .01, length = Math.floor(c.sampleRate * .35);
  const buffer = c.createBuffer(1, length, c.sampleRate), data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const noise = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
  noise.buffer = buffer; filter.type = 'bandpass'; filter.Q.value = 7;
  filter.frequency.setValueAtTime(180, at); filter.frequency.exponentialRampToValueAtTime(420, at + .3);
  gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(.12, at + .04);
  gain.gain.exponentialRampToValueAtTime(.0001, at + .35);
  noise.connect(filter).connect(gain).connect(dest); noise.start(at);
  noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
}
export function playDoorClose(dest: AudioNode = categoryOutput('effects')) {
  const c = audio(); tap(c, c.currentTime + .01, 130, .09, dest);
}
export function playHand() {
  const dest = categoryOutput('effects'), c = audio(), t = c.currentTime + .02;
  for (const [delay, hz] of [[0, 660], [.12, 880]])
    tone(c, dest, t + delay, { hz, level: .055, attack: .008, decay: .18 });
}

/** A brass desk bell: a bright strike with two inharmonic partials, ringing out for about a second. */
export function playBell(dest: AudioNode = categoryOutput('effects')) {
  try {
    const c = audio(), at = c.currentTime + .01;
    const out = c.createGain();
    out.gain.setValueAtTime(0, at); out.gain.linearRampToValueAtTime(1, at + .004); out.gain.exponentialRampToValueAtTime(.0001, at + 1.1);
    out.connect(dest);
    const oscs = [[1568, .09, 1.1], [1568 * 2.76, .05, .45], [1568 * 5.4, .02, .18]].map(([hz, level, ring]) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = hz;
      g.gain.setValueAtTime(level, at); g.gain.exponentialRampToValueAtTime(.0001, at + ring);
      osc.connect(g).connect(out); osc.start(at); osc.stop(at + ring + .05);
      return { osc, g };
    });
    oscs[0].osc.onended = () => { for (const { osc, g } of oscs) { osc.disconnect(); g.disconnect(); } out.disconnect(); };
  } catch { /* audio unavailable: stay silent */ }
}

/** Short cabinet effects, all routed through the shared Effects mix and deafen control. */
export function playPark(kind: import('../../shared/park/sim').FxKind | 'cheer') {
  const notes: Record<typeof kind, number[]> = {
    jump: [260, 520], coin: [880, 1320], key: [660, 990, 1320], door: [220, 330, 440],
    button: [180, 240], stomp: [180, 100], death: [320, 200, 100], respawn: [330, 440, 660],
    clear: [523, 659, 784, 1047], select: [440, 660], cheer: [520, 880],
  };
  try {
    const c = audio(), dest = categoryOutput('effects'), sequence = notes[kind];
    sequence.forEach((hz, i) => {
      tone(c, dest, c.currentTime + .01 + i * .055, { hz, level: .055, attack: .005, decay: .12,
        type: kind === 'death' || kind === 'stomp' ? 'triangle' : 'sine' });
    });
  } catch { /* audio unavailable: stay silent */ }
}

/** Dungeon discoveries use the same quiet effects bus as the office UI. */
export function playDungeon(event: 'fell' | 'key' | 'locked' | 'opening' | 'escaped') {
  try {
    const c = audio(), t = c.currentTime + .01, dest = categoryOutput('effects');
    const note = (delay: number, hz: number, end: number, duration: number, level: number, type: OscillatorType = 'sine') =>
      tone(c, dest, t + delay, { hz, to: end, level, attack: .008, decay: duration, type });
    if (event === 'fell') { note(0, 950, 180, .42, .035); tap(c, t + .43, 100, .08, dest); }
    else if (event === 'key') { note(0, 1047, 1047, .18, .045); note(.12, 1568, 1568, .24, .04); }
    else if (event === 'locked') for (let i = 0; i < 3; i++) note(i * .045, 870 + i * 170, 570, .055, .022, 'triangle');
    else if (event === 'opening') { tap(c, t, 420, .055, dest); note(.06, 140, 75, .35, .03, 'triangle'); }
    else [523, 659, 784].forEach((hz, i) => note(i * .11, hz, hz, .23, .045));
  } catch { /* audio unavailable: stay silent */ }
}
