// Tiny synthesized UI sounds (no audio files). Meant to be noticed, not to startle:
// short, low, quiet, and never repeating on their own.

const KEY = 'deck.sounds';
let ctx: AudioContext | null = null;

export const soundsOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export const setSoundsOn = (on: boolean) => { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ } };

const audio = () => {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
};
// Browsers only start audio after a user gesture; warm the context on the first click so a later knock can play.
if (typeof window !== 'undefined') {
  const warm = () => { audio(); window.removeEventListener('pointerdown', warm); window.removeEventListener('keydown', warm); };
  window.addEventListener('pointerdown', warm);
  window.addEventListener('keydown', warm);
}

/** One soft knuckle tap on wood: a low body thump plus a filtered click, decaying in ~0.1 s. */
function tap(c: AudioContext, at: number, pitch: number, level: number) {
  const out = c.createGain();
  out.gain.setValueAtTime(0, at);
  out.gain.linearRampToValueAtTime(level, at + 0.004);
  out.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1400;
  out.connect(lp).connect(c.destination);

  // body: a quick downward-bending sine
  const body = c.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(pitch, at);
  body.frequency.exponentialRampToValueAtTime(pitch * 0.6, at + 0.1);
  body.connect(out);
  body.start(at); body.stop(at + 0.14);

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
}

/** "tok-tok": two gentle knocks, the second a touch softer and lower. */
export function playKnock() {
  if (!soundsOn()) return;
  try {
    const c = audio();
    const t = c.currentTime + 0.02;
    tap(c, t, 210, 0.16);
    tap(c, t + 0.16, 190, 0.12);
  } catch { /* audio unavailable: stay silent */ }
}

/** A soft bubbly "pop" for a reaction or a message: one short rising sine. */
export function playPop() {
  if (!soundsOn()) return;
  try {
    const c = audio(), at = c.currentTime + 0.01;
    const g = c.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.09, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    g.connect(c.destination);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(520, at);
    o.frequency.exponentialRampToValueAtTime(880, at + 0.08);
    o.connect(g); o.start(at); o.stop(at + 0.18);
  } catch { /* audio unavailable: stay silent */ }
}
