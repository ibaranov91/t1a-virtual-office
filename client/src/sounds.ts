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

/** A party popper: a sharp bang and a fizz of falling confetti. `level` 0..1 is how close it was. */
export function playPopper(level = 1) {
  try {
    const c = audio(), at = c.currentTime + 0.01, out = categoryOutput('effects');
    tone(c, out, at, { hz: 180, to: 60, glide: .05, level: .16 * level, attack: .002, decay: .1 });
    tone(c, out, at, { hz: 1800, to: 900, glide: .06, level: .06 * level, attack: .001, decay: .05 });
    for (let i = 0; i < 6; i++) tone(c, out, at + .06 + i * .045, { hz: 2400 + i * 260, to: 1600, glide: .05, level: .03 * level, attack: .002, decay: .06 });
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
/** An espresso moment as long as the brew (~1.2 s): a soft pump hum, a little hiss and two drips, then a tiny "ready" ding.
 *  Levels put its loudest moment (A-weighted) level with the door creak. */
export function playCoffeeBrew(pan = 0) {
  try {
    const c = audio(), at = c.currentTime + .01, p = c.createStereoPanner();
    p.pan.value = pan; p.connect(categoryOutput('effects'));
    window.setTimeout(() => p.disconnect(), 1800);
    // pump: a low buzz (its harmonics carry on small speakers), swelling in and settling out by 0.8 s
    const pump = c.createOscillator(), lp = c.createBiquadFilter(), hum = c.createGain();
    pump.type = 'sawtooth'; pump.frequency.setValueAtTime(64, at); pump.frequency.linearRampToValueAtTime(58, at + .8);
    lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = .7;
    hum.gain.value = 0; hum.gain.setValueAtTime(0, at); hum.gain.linearRampToValueAtTime(.0105, at + .12);
    hum.gain.setValueAtTime(.0105, at + .55); hum.gain.exponentialRampToValueAtTime(.0001, at + .82);
    pump.connect(lp).connect(hum).connect(p); pump.start(at); pump.stop(at + .85);
    pump.onended = () => { pump.disconnect(); lp.disconnect(); hum.disconnect(); };
    // hiss: steam through the spout, rising as the pump settles and fading under the drips
    const len = Math.floor(c.sampleRate * .7), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource(), bp = c.createBiquadFilter(), hiss = c.createGain(), t = at + .45;
    noise.buffer = buf; bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = .9;
    hiss.gain.value = 0; // silent from now, not just from t: the noise can start a sample early, which would click
    hiss.gain.setValueAtTime(0, t); hiss.gain.linearRampToValueAtTime(.0028, t + .2); hiss.gain.exponentialRampToValueAtTime(.0001, t + .68);
    noise.connect(bp).connect(hiss).connect(p); noise.start(t);
    noise.onended = () => { noise.disconnect(); bp.disconnect(); hiss.disconnect(); };
    // drips, then the ready ding
    tone(c, p, at + .86, { hz: 720, to: 1250, glide: .03, level: .0034, attack: .003, decay: .07 });
    tone(c, p, at + 1.0, { hz: 660, to: 1150, glide: .03, level: .0025, attack: .003, decay: .07 });
    tone(c, p, at + 1.16, { hz: 1319, level: .0015, attack: .005, decay: .4 });
    tone(c, p, at + 1.16, { hz: 1319 * 2.76, level: .00025, attack: .005, decay: .12 });
  } catch { /* audio unavailable: stay silent */ }
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

/** A glass hitting the floor: a bright burst of filtered noise and a scatter of little tinkles, gone in under a second. */
export function playShatter(dest: AudioNode = categoryOutput('effects')) {
  try {
    const c = audio(), at = c.currentTime + .01, len = Math.floor(c.sampleRate * .35);
    const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const noise = c.createBufferSource(), hp = c.createBiquadFilter(), g = c.createGain();
    noise.buffer = buf; hp.type = 'highpass'; hp.frequency.value = 2600; g.gain.value = .22;
    noise.connect(hp).connect(g).connect(dest); noise.start(at);
    noise.onended = () => { noise.disconnect(); hp.disconnect(); g.disconnect(); };
    for (let i = 0; i < 6; i++) tone(c, dest, at + .02 + i * .045 + Math.random() * .03, { hz: 3200 + Math.random() * 2600, level: .035, attack: .002, decay: .12 + Math.random() * .1 });
  } catch { /* audio unavailable: stay silent */ }
}

/** A cup tipping over onto the floor: a dull ceramic clink and a soft thud. */
export function playClink(dest: AudioNode = categoryOutput('effects')) {
  try {
    const c = audio(), at = c.currentTime + .01;
    tone(c, dest, at, { hz: 2300, level: .06, attack: .002, decay: .16 });
    tone(c, dest, at, { hz: 3450, level: .025, attack: .002, decay: .09 });
    tone(c, dest, at + .07, { hz: 1900, level: .03, attack: .002, decay: .1 });
    tone(c, dest, at, { hz: 180, to: 90, level: .08, attack: .003, decay: .12 });
  } catch { /* audio unavailable: stay silent */ }
}

/** Short cabinet effects, all routed through the shared Effects mix and deafen control. */
export function playPark(kind: string) {
  const notes: Record<string, number[]> = {
    jump: [260, 520], coin: [880, 1320], key: [660, 990, 1320], door: [220, 330, 440],
    button: [180, 240], stomp: [180, 100], death: [320, 200, 100], respawn: [330, 440, 660],
    vote: [660, 880], crack: [140, 90], tackle: [180, 320], crown: [880, 1175], steal: [440, 880, 1175],
    arrow: [740, 370], arrowstick: [180, 120], pickup: [660, 990], heat: [523, 784, 1047],
    rundash: [180, 520], shove: [180, 270], volleyhit: [420, 600], volleyspike: [260, 130], volleypoint: [523, 659, 880],
    bikejump: [330, 660], bikeboost: [220, 440], bikecrash: [180, 90], skybounce: [390, 580], skyspring: [520, 1040], skybreak: [190, 110],
    title: [330, 660], scores: [523, 659], favourite: [660, 784], bonus: [784, 988, 1175], awards: [523, 659, 784, 1047],
    clear: [523, 659, 784, 1047], select: [440, 660], cheer: [520, 880],
  };
  try {
    const c = audio(), dest = categoryOutput('effects'), sequence = notes[kind] ?? [];
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

// ---------- game table (Effects bus) ----------
export function playTable(finished = false) {
  try {
    const c = audio(), at = c.currentTime + .01, out = categoryOutput('effects');
    tone(c, out, at, { hz: finished ? 440 : 220, to: finished ? 660 : 160, level: .065, attack: .004, decay: .12, type: 'triangle' });
    if (finished) tone(c, out, at + .12, { hz: 880, level: .045, attack: .008, decay: .22 });
  } catch { /* audio unavailable */ }
}

/** A quiet three-note trophy chime, with a little high shimmer. */
export function playAchievement() {
  try {
    const c = audio(), dest = categoryOutput('effects'), at = c.currentTime + .01;
    [784, 988, 1319].forEach((hz, i) => {
      tone(c, dest, at + i * .11, { hz, level: .028, attack: .008, decay: .44 });
      tone(c, dest, at + i * .11, { hz: hz * 2.76, level: .004, attack: .003, decay: .18 });
    });
    const noise = c.createBuffer(1, Math.ceil(c.sampleRate * .3), c.sampleRate), data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = noise; filter.type = 'bandpass'; filter.frequency.value = 6500; filter.Q.value = 2;
    gain.gain.setValueAtTime(0, at + .22); gain.gain.linearRampToValueAtTime(.012, at + .24);
    gain.gain.exponentialRampToValueAtTime(.0001, at + .52);
    source.connect(filter).connect(gain).connect(dest); source.start(at + .22); source.stop(at + .53);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  } catch { /* audio unavailable: stay silent */ }
}

/** Two quiet notes confirm a change of microphone or hearing state. */
export function playMuteBlip(muted: boolean) {
  try {
    const c = audio(), dest = categoryOutput('effects'), at = c.currentTime + .01;
    (muted ? [660, 440] : [440, 660]).forEach((hz, i) =>
      tone(c, dest, at + i * .09, { hz, level: .045, attack: .005, decay: .1 }));
  } catch { /* audio unavailable */ }
}
export const playDeafenBlip = playMuteBlip;
