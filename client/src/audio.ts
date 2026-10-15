// One context for voices, emitters, meters and UI sounds.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let deafened = false;
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
