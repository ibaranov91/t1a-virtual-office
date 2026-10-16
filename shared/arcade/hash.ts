/** FNV-1a over tagged JSON leaves and sorted keys. Effects never affect a simulation's future. */
export function hash(value: unknown): number {
  let h = 2166136261;
  const byte = (v: number) => { h = Math.imul(h ^ v, 16777619) >>> 0; };
  const str = (v: string) => { for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); byte(c & 255); byte(c >>> 8); } byte(255); };
  const walk = (v: unknown): void => {
    if (v === null) { byte(0); return; }
    if (Array.isArray(v)) { byte(1); str(String(v.length)); v.forEach(walk); return; }
    if (typeof v === 'object') { byte(2); for (const k of Object.keys(v).filter(k => k !== 'fx').sort()) { str(k); walk((v as Record<string, unknown>)[k]); } byte(254); return; }
    byte(typeof v === 'number' ? 3 : typeof v === 'boolean' ? 4 : 5); str(String(v));
  };
  walk(value); return h;
}
