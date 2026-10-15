// One context for voices, emitters, meters and UI sounds.
import { prefs, subscribePrefs, type Category } from './prefs';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let deafened = prefs.deafened;
const categories = new Map<Category, GainNode>();
const failed = new Set<HTMLAudioElement>();
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    ctx.addEventListener('statechange', changed);
  }
  return ctx;
}
export function output() {
  if (!master) {
    master = audio().createGain(); master.gain.value = deafened ? 0 : 1;
    master.connect(audio().destination);
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
export async function playMedia(el: HTMLAudioElement) {
  try { await el.play(); failed.delete(el); }
  catch { if (el.srcObject) failed.add(el); }
  changed();
}
export function forgetMedia(el: HTMLAudioElement) { if (failed.delete(el)) queueMicrotask(changed); }
export async function resume() {
  await audio().resume().catch(() => {});
  await Promise.all([...failed].map(playMedia));
  changed();
}
if (typeof window !== 'undefined') {
  const warm = () => { void resume(); };
  window.addEventListener('pointerdown', warm);
  window.addEventListener('keydown', warm);
}
