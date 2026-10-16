export type Category = 'voice' | 'music' | 'effects';
interface Prefs {
  deafened: boolean; mode: 'voice' | 'ptt';
  mix: Record<Category, number>;
  jukeboxVolumes: Record<string, number>;
  volumes: Record<string, number>; localMuted: Record<string, true>;
  retroVolume: number; retroMuted: boolean; // the retro cabinets' game sound, for me
}
const KEY = 'deck.voice';
const defaults = (): Prefs => ({ deafened: false, mode: 'voice', mix: { voice: 1, music: 1, effects: 1 }, jukeboxVolumes: {}, volumes: {}, localMuted: {}, retroVolume: .5, retroMuted: false });
function load(): Prefs {
  const p = defaults();
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!v || typeof v !== 'object') return p;
    p.deafened = v.deafened === true; p.mode = v.mode === 'ptt' ? 'ptt' : 'voice';
    for (const id of Object.keys(p.mix) as Category[]) {
      const n = v.mix?.[id];
      if (typeof n === 'number' && Number.isFinite(n)) p.mix[id] = Math.max(0, Math.min(1, n));
    }
    for (const [id, n] of Object.entries(v.jukeboxVolumes ?? {}))
      if (typeof n === 'number' && Number.isFinite(n)) p.jukeboxVolumes[id] = Math.max(0, Math.min(1, n));
    for (const [id, n] of Object.entries(v.volumes ?? {}))
      if (!id.startsWith('obj:') && typeof n === 'number' && Number.isFinite(n)) p.volumes[id] = Math.max(0, Math.min(2, n));
    for (const [id, on] of Object.entries(v.localMuted ?? {})) if (!id.startsWith('obj:') && on === true) p.localMuted[id] = true;
    if (typeof v.retroVolume === 'number' && Number.isFinite(v.retroVolume)) p.retroVolume = Math.max(0, Math.min(1, v.retroVolume));
    p.retroMuted = v.retroMuted === true;
  } catch { /* defaults */ }
  return p;
}
export const prefs = load();
const listeners = new Set<() => void>();
const changed = () => { for (const fn of listeners) fn(); };
export const subscribePrefs = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function savePrefs() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  changed();
}
try {
  if (localStorage.getItem('deck.sounds') === 'off') prefs.mix.effects = 0;
  // Persist the migration and remove object preferences even if no controls are used.
  localStorage.setItem(KEY, JSON.stringify(prefs)); localStorage.removeItem('deck.sounds');
} catch { /* storage unavailable */ }
window.addEventListener('storage', e => {
  try {
    if (e.storageArea === localStorage && (e.key === KEY || e.key === null)) { Object.assign(prefs, load()); changed(); }
  } catch { /* storage unavailable */ }
});
export const volumeFor = (id: string) => prefs.localMuted[id] ? 0 : prefs.volumes[id] ?? 1;
