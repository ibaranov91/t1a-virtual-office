import { diag } from './voiceDiag';
// One context for voices, emitters, meters and UI sounds.
import { prefs, subscribePrefs, type Category } from './prefs';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let deafened = prefs.deafened;
const categories = new Map<Category, GainNode>();
const attempts = new WeakMap<HTMLAudioElement, object>();
const failed = new Set<HTMLAudioElement>();
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };
/** Safari and the Mac app (WKWebView): once the mic is open, macOS voice processing mangles Web Audio output, so call
 *  voices play from their own <audio> element instead (volume follows the soundscape, no pan or reverb). */
export const DIRECT_VOICE = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent);

export function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    diag.observeContext(ctx);
    ctx.addEventListener('statechange', changed);
  }
  return ctx;
}
function output() {
  if (!master) {
    master = audio().createGain(); master.gain.value = deafened ? 0 : 1;
    master.connect(audio().destination);
    if (import.meta.env.DEV) {
      const analyser = audio().createAnalyser(); analyser.fftSize = 2048; master.connect(analyser);
      Object.assign(window, { __audioRms: () => rms(analyser) });
    }
  }
  return master;
}
export function categoryOutput(category: Category) {
  if (!categories.has(category)) {
    const bus = audio().createGain(); bus.gain.value = prefs.mix[category];
    bus.connect(output()); categories.set(category, bus);
  }
  return categories.get(category)!;
}
subscribePrefs(() => {
  setAudioDeafened(prefs.deafened);
  for (const [id, bus] of categories) bus.gain.setTargetAtTime(prefs.mix[id], audio().currentTime, .08);
});
export function setAudioDeafened(on: boolean) {
  deafened = on;
  if (master) master.gain.setTargetAtTime(on ? 0 : 1, audio().currentTime, .08);
}
export const needsGesture = () => audio().state !== 'running' || failed.size > 0;
export const subscribeAudio = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function rms(analyser: AnalyserNode) {
  const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
  return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
}
export async function playMedia(el: HTMLAudioElement, current = () => true, quiet = false): Promise<'playing' | 'blocked' | 'error' | 'aborted'> {
  const attempt = {}; attempts.set(el, attempt);
  const valid = () => attempts.get(el) === attempt && current();
  let result: 'playing' | 'blocked' | 'error' | 'aborted' = 'playing';
  try { await el.play(); if (valid()) failed.delete(el); }
  catch (err) {
    if (!valid()) { diag.mediaResult(el, 'aborted'); return 'aborted'; }
    if (err instanceof DOMException && err.name === 'NotAllowedError') { if (!quiet) failed.add(el); result = 'blocked'; }
    else {
      failed.delete(el);
      if (err instanceof DOMException && err.name === 'AbortError') result = 'aborted';
      else { console.warn('audio playback', err); result = 'error'; }
    }
  }
  if (!valid()) { diag.mediaResult(el, 'aborted'); return 'aborted'; }
  diag.mediaResult(el, result);
  changed(); return result;
}
export function forgetMedia(el: HTMLAudioElement) {
  attempts.delete(el);
  if (failed.delete(el)) queueMicrotask(changed);
}
export async function resume() {
  // Start retries in the gesture's synchronous stack; WebKit requires this ordering.
  const retries = [...failed].map(el => playMedia(el));
  await audio().resume().catch(() => {});
  await Promise.all(retries);
  changed();
}
/** Safari lets an element start playing on its own only once it has been played inside a click: elements registered
 *  here get a silent play + pause on the first gesture, so later starts don't need an "Enable sound" click. */
const locked = new Set<HTMLAudioElement>();
export const unlockOnGesture = (el: HTMLAudioElement) => { locked.add(el); };
if (typeof window !== 'undefined') {
  const warm = () => {
    for (const el of locked) if (el.paused && !failed.has(el)) { el.play().catch(() => {}); el.pause(); }
    locked.clear();
    void resume();
  };
  window.addEventListener('pointerdown', warm);
  window.addEventListener('keydown', warm);
}
