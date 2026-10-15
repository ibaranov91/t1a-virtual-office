import type { InstrumentKind } from '../../shared/instruments';

export interface SynthVoice { release(when: number): void; stop(): void; done: Promise<void> }

/** Small, self-contained patches. The output envelope owns the lifetime of every node. */
export function startVoice(c: AudioContext, dest: AudioNode, kind: InstrumentKind, preset: number, note: number, vel: number, when: number): SynthVoice {
  const at = Math.max(c.currentTime, when), f = 440 * 2 ** ((note - 69) / 12), bright = vel / 127;
  const nodes: AudioNode[] = [], sources: AudioScheduledSourceNode[] = [];
  const keep = <T extends AudioNode>(n: T): T => { nodes.push(n); return n; };
  const out = keep(c.createGain()); out.connect(dest);
  const peak = .4 * bright ** 2;
  out.gain.setValueAtTime(0, at); out.gain.linearRampToValueAtTime(peak, at + .005);
  let releaseTime = .15, duration = Infinity, ended = false, ending = Infinity; // Infinity: sounds until released
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const cleanup = () => { if (ended) return; ended = true; for (const n of nodes) n.disconnect(); finish(); };
  const filter = (type: BiquadFilterType, hz: number, q = .7, target: AudioNode = out) => {
    const n = keep(c.createBiquadFilter()); n.type = type; n.frequency.setValueAtTime(hz, at); n.Q.value = q; n.connect(target); return n;
  };
  const osc = (type: OscillatorType, hz: number, level: number, target: AudioNode = out, detune = 0) => {
    const o = keep(c.createOscillator()), g = keep(c.createGain()); o.type = type; o.frequency.setValueAtTime(hz, at); o.detune.value = detune;
    g.gain.value = level; o.connect(g).connect(target); sources.push(o); return o;
  };
  const noise = (seconds: number, target: AudioNode, level = 1, delay = 0) => {
    const n = keep(c.createBufferSource()), g = keep(c.createGain());
    const b = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = b; g.gain.setValueAtTime(0, at); g.gain.setValueAtTime(level, at + delay);
    g.gain.exponentialRampToValueAtTime(.0001, at + delay + seconds);
    n.connect(g).connect(target); sources.push(n);
    // All sources start together; offset bursts use an envelope and a buffer long enough for the delay.
    if (delay) { const padded = c.createBuffer(1, d.length + Math.ceil(delay * c.sampleRate), c.sampleRate); padded.getChannelData(0).set(d, Math.ceil(delay * c.sampleRate)); n.buffer = padded; }
  };
  if (kind === 'keys' && preset === 0) {
    releaseTime = .3;
    const carrier = osc('sine', f, .75), modGain = keep(c.createGain());
    modGain.gain.setValueAtTime(f * (1 + 4 * bright), at); modGain.gain.exponentialRampToValueAtTime(f * .05, at + 1.4);
    osc('sine', f, 1, modGain); modGain.connect(carrier.frequency);
    const bell = keep(c.createGain()); bell.gain.setValueAtTime(.2 * bright, at); bell.gain.exponentialRampToValueAtTime(.0001, at + .4); bell.connect(out);
    osc('sine', f * 14, 1, bell);
    out.gain.exponentialRampToValueAtTime(.0001, at + 2); duration = 2.1;
  } else if (kind === 'keys' && preset === 1) {
    releaseTime = .08;
    const vibrato = keep(c.createGain()); vibrato.gain.value = 3; osc('sine', 6, 1, vibrato);
    for (const [ratio, level] of [[1,.35],[2,.22],[3,.13],[4,.08],[6,.05]]) vibrato.connect(osc('sine', f * ratio, level).detune);
    noise(.015, filter('highpass', 2500), .15);
  } else if ((kind === 'keys' && preset === 2) || (kind === 'bass' && preset === 0)) {
    const bass = kind === 'bass'; releaseTime = bass ? .12 : .2;
    const low = filter('lowpass', Math.min(18000, f * (4 + bright * 24)), bass ? 5 : 1.5);
    low.frequency.exponentialRampToValueAtTime(Math.max(80, f * (1 + bright * 3)), at + .22);
    osc('sawtooth', f, bass ? .45 : .3, low, -7);
    if (!bass) osc('sawtooth', f, .3, low, 7);
    osc('square', f / 2, .2, low);
  } else if (kind === 'bass') {
    out.gain.cancelScheduledValues(at); out.gain.setValueAtTime(0, at); out.gain.linearRampToValueAtTime(peak, at + .01);
    const low = filter('lowpass', 500 + bright * 2500); osc('sine', f, .8, low); osc('triangle', f, .15, low);
  } else {
    switch (note) {
      case 36: {
        duration = .55; const o = osc('sine', 150, 1); o.frequency.exponentialRampToValueAtTime(45, at + .15); break;
      }
      case 38: duration = .22; osc('sine', 180, .45); noise(.2, filter('bandpass', 1800, .6), 1.5); break;
      case 42: case 46: duration = note === 42 ? .05 : .4; noise(duration, filter('highpass', 7000), 1.7); break;
      case 39: {
        duration = .3; const bp = filter('bandpass', 1600, .8);
        for (const delay of [0, .012, .024]) noise(.012, bp, 1.4, delay);
        noise(.22, bp, .8, .036); break;
      }
      case 41: case 45: case 48: {
        duration = .4; const hz = note === 41 ? 100 : note === 45 ? 145 : 200;
        const o = osc('sine', hz * 1.7, 1); o.frequency.exponentialRampToValueAtTime(hz, at + .1); break;
      }
      case 49: duration = 1.5; noise(duration, filter('highpass', 5000), 1.8); break;
      case 51: duration = 1; for (const hz of [317, 541, 823, 1133]) osc('square', hz, .09, filter('highpass', 3500)); break;
      case 37: duration = .035; osc('square', 1600, .5); noise(.02, filter('bandpass', 2200), .6); break;
      case 56: duration = .2; { const bp = filter('bandpass', 900, 1); osc('square', 540, .4, bp); osc('square', 800, .4, bp); } break;
    }
    out.gain.exponentialRampToValueAtTime(.0001, at + duration);
  }
  // A silent lifetime source also covers patches containing only short noise buffers.
  const lifetime = keep(c.createOscillator()), silent = keep(c.createGain()); silent.gain.value = 0;
  lifetime.connect(silent).connect(out); sources.push(lifetime); lifetime.onended = cleanup;
  for (const s of sources) { s.start(at); if (duration < Infinity) s.stop(at + duration + .01); }
  const end = (time: number, tail: number) => {
    if (ended) return;
    const t = Math.max(c.currentTime, time), stopAt = t < at ? t : t + tail;
    if (stopAt >= ending) return; ending = stopAt;
    if (t < at) { out.gain.cancelScheduledValues(0); out.gain.setValueAtTime(0, c.currentTime); }
    else {
      if (out.gain.cancelAndHoldAtTime) out.gain.cancelAndHoldAtTime(t);
      else { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); } // Firefox
      out.gain.linearRampToValueAtTime(0, stopAt);
    }
    for (const s of sources) s.stop(stopAt);
  };
  return { release: time => end(time, releaseTime), stop: () => end(c.currentTime, .01), done };
}
