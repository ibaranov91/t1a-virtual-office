// A personal pomodoro timer (v2): started from the sidebar's bottom strip, public while it runs (a 🍅 over your sprite).
// Focus first, then a break, then it's over. Pure rules; the server keeps `User.pomodoro` and ticks it.
export interface Pomodoro { phase: 'focus' | 'break'; until: number; focus: number; rest: number } // focus/rest: minutes
export const POMODORO_FOCUS = 25, POMODORO_REST = 5;
const minutes = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 120 ? n : fallback);
/** A fresh focus session (25 minutes, then a 5 minute break by default). */
export const startPomodoro = (now: number, focus?: unknown, rest?: unknown): Pomodoro => {
  const f = minutes(focus, POMODORO_FOCUS), r = minutes(rest, POMODORO_REST);
  return { phase: 'focus', until: now + f * 60_000, focus: f, rest: r };
};
/** Time up for the current phase? Focus turns into the break; the break ends the timer (`next` null). */
export function advancePomodoro(p: Pomodoro, now: number): { next: Pomodoro | null; ended: Pomodoro['phase'] } | null {
  if (p.until > now) return null;
  return p.phase === 'focus' ? { next: { ...p, phase: 'break', until: now + p.rest * 60_000 }, ended: 'focus' } : { next: null, ended: 'break' };
}
export const pomodoroLeft = (p: Pomodoro, now: number) => Math.max(0, p.until - now);
/** m:ss for the countdown. */
export const pomodoroClock = (ms: number) => { const s = Math.ceil(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
