interface Prefs {
  muted: boolean; deafened: boolean; mode: 'voice' | 'ptt';
  volumes: Record<string, number>; localMuted: Record<string, true>;
}
const defaults = (): Prefs => ({ muted: false, deafened: false, mode: 'voice', volumes: {}, localMuted: {} });
function load(): Prefs {
  const p = defaults();
  try {
    const v = JSON.parse(localStorage.getItem('deck.voice') ?? 'null');
    if (!v || typeof v !== 'object') return p;
    p.muted = v.muted === true; p.deafened = v.deafened === true; p.mode = v.mode === 'ptt' ? 'ptt' : 'voice';
    for (const [id, n] of Object.entries(v.volumes ?? {}))
      if (typeof n === 'number' && Number.isFinite(n)) p.volumes[id] = Math.max(0, Math.min(2, n));
    for (const [id, on] of Object.entries(v.localMuted ?? {})) if (on === true) p.localMuted[id] = true;
  } catch { /* defaults */ }
  return p;
}
export const prefs = load();
export function savePrefs() { try { localStorage.setItem('deck.voice', JSON.stringify(prefs)); } catch { /* ignore */ } }
export const volumeFor = (id: string) => prefs.localMuted[id] ? 0 : prefs.volumes[id] ?? 1;
