import { START } from './buttons';
export type Reader = (addr: number) => number;
export interface ProbeResult { track: string; score: number; time?: number }
export interface Probe {
  start(): unknown;
  step(state: unknown, read: Reader): ProbeResult | null;
  pending(state: unknown, read: Reader): boolean;
  settle: { press: number; maxFrames: number };
}
const word = (r: Reader, a: number) => r(a) | (r(a + 1) << 8);
function invalid(): null { console.warn('Invalid retro probe bytes; result skipped'); return null; }
export function digits(read: Reader, addr: number): number | null {
  let n = 0;
  for (let i = 0; i < 8; i++) { const b = read(addr + i); if (b !== 128 && (b < 0 || b > 9)) return null; n = n * 10 + (b & 127); }
  return n;
}
interface LobsterState { armed: boolean; ending: boolean }
export const lobsterProbe: Probe = {
  start: (): LobsterState => ({ armed: false, ending: false }),
  step(state, r) {
    const s = state as LobsterState, mode = r(0xffaa), message = r(0xff80);
    if (mode === 2 && (message === 0 || message === 1)) s.armed = true;
    if (s.armed && mode === 2 && message === 4) { s.armed = false; s.ending = true; }
    if (!s.ending || word(r, 0xcb80) || r(0xcb82)) return null;
    s.ending = false;
    const score = digits(r, 0xc8f0), speed = r(0xcd0a);
    if (score === null || speed < 1 || speed > 3) return invalid();
    return { track: ['slow', 'medium', 'fast'][speed - 1], score };
  },
  pending: state => (state as LobsterState).ending,
  settle: { press: START, maxFrames: 60 },
};
interface TobuSample { gs: number; ss: number; level: number; lcd: number }
interface TobuState { prev: TobuSample | null; death: boolean }
export const tobuProbe: Probe = {
  start: (): TobuState => ({ prev: null, death: false }),
  step(state, r) {
    const s = state as TobuState, prev = s.prev;
    const cur = { gs: r(0xc0a5), ss: r(0xc0a6), level: r(0xc0a7), lcd: r(0xff40) };
    s.prev = cur; if (cur.ss !== 1) s.death = false;
    if (!prev) return null;
    const time = word(r, 0xc0b3);
    if (prev.gs === 4 && (cur.gs === 6 || cur.gs === 10) && cur.level >= 1 && cur.level <= 4) {
      const kills = word(r, 0xc0b5);
      return { track: ['plains', 'clouds', 'space', 'dream'][cur.level - 1], score: 3 * Math.max(0, [56, 56, 64, 64][cur.level - 1] - time) + kills, time };
    }
    const dead = (v: TobuSample) => v.gs === 4 && v.ss === 1 && (v.lcd & 0xa0) === 0xa0;
    if (dead(cur) && dead(prev) && !s.death) {
      s.death = true;
      if (cur.level === 5) return { track: 'heaven', score: word(r, 0xc0b7) + 1, time };
    }
    return null;
  },
  pending: (_s, r) => r(0xc0a5) === 4 && r(0xc0a7) >= 1 && r(0xc0a7) <= 4 && r(0xc0a6) === 2,
  settle: { press: 0, maxFrames: 400 },
};
