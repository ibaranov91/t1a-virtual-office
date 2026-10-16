// Drunk speech, purely cosmetic: the drawn text only, never the stored message. Deterministic for the same
// (text, level, seed), so every viewer sees the same slur.
import { DRUNK_MAX_MS, drunkLevel, effectOf } from '../../shared/effects';
import type { Effect } from '../../shared/protocol';

function rand(seed: string | number) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { // mulberry32
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONSONANT = /[bcdfgklmnprtvz]/i;

export function slur(text: string, level: number, seed: string | number): string {
  if (level <= 0 || !text) return text;
  const r = rand(seed), double = 0.05 * level, shh = 0.2 * level;
  const out = text.split(/(\s+)/).map(word => {
    if (/^\s*$/.test(word) || /:\/\/|@/.test(word)) return word; // links and emails stay usable
    let w = '';
    for (let i = 0; i < word.length; i++) {
      const c = word[i], next = word[i + 1] ?? '';
      if ((c === 's' || c === 'S') && next.toLowerCase() !== 'h' && r() < shh) w += c + (c === 'S' && next === next.toUpperCase() && next !== next.toLowerCase() ? 'H' : 'h');
      else if (CONSONANT.test(c) && i > 0 && next !== c && r() < double) w += c + c.toLowerCase();
      else w += c;
    }
    return w;
  }).join('');
  return level >= 3 && r() < 0.4 ? `${out}...hic` : out;
}

/** Slur a message by `effects`' owner if they're drunk now and it was sent while they could have been. */
export function slurBy(effects: Effect[] | undefined, text: string, at: number, seed: string | number, now = Date.now()) {
  const e = effectOf(effects ?? [], 'drunk');
  if (!e || (e.until !== undefined && (e.until <= now || at < e.until - DRUNK_MAX_MS))) return text;
  return slur(text, drunkLevel(e), seed);
}
