export interface RandomState { rng: number }
/** mulberry32, with the mutable word in the JSON snapshot. */
export function random(s: RandomState): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = Math.imul(s.rng ^ (s.rng >>> 15), 1 | s.rng);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return (t ^ (t >>> 14)) >>> 0;
}
export function shuffle<T>(s: RandomState, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) { const j = random(s) % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
