export type ReminderKind = 'water' | 'stretch';
export type WellnessKind = ReminderKind | 'pomodoro';
export type Phase = 'focus' | 'short' | 'long';
export interface Reminder { enabled: boolean; intervalMin: number; nextAt: number | null }
export interface Pomodoro {
  phase: Phase; status: 'idle' | 'running' | 'paused' | 'finished';
  durations: Record<Phase, number>; remainingMs: number; endsAt: number | null; rounds: number;
}
export interface WellnessState { version: 1; water: Reminder; stretch: Reminder; pomodoro: Pomodoro; exercise: number }
export type WellnessAction =
  | { type: 'enable'; kind: ReminderKind; enabled: boolean }
  | { type: 'interval'; kind: ReminderKind; minutes: number }
  | { type: 'done' | 'snooze'; kind: ReminderKind }
  | { type: 'phase'; phase: Phase }
  | { type: 'duration'; phase: Phase; minutes: number }
  | { type: 'start' | 'pause' | 'reset' | 'next' };
export interface WellnessRequest { kind: WellnessKind; at: number; title: string; body: string }
export const createWellness = (): WellnessState => ({
  version: 1, water: { enabled: false, intervalMin: 30, nextAt: null }, stretch: { enabled: false, intervalMin: 60, nextAt: null },
  pomodoro: { phase: 'focus', status: 'idle', durations: { focus: 25, short: 5, long: 15 }, remainingMs: 1_500_000, endsAt: null, rounds: 0 }, exercise: 0,
});
export const PHASE_NAMES: Record<Phase, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' };
export const EXERCISES = [
  { name: 'Reach up', text: 'Stand up and reach your arms overhead. Take a few easy breaths, then relax.' },
  { name: 'Squats', text: 'Step away from your chair and try a few gentle squats at your own pace.' },
  { name: 'Heel raises', text: 'Stand beside your desk, rise onto your toes, then slowly lower your heels.' },
] as const;
const validMinutes = (n: number) => Number.isInteger(n) && n >= 1 && n <= 180;
const validTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 8.64e15;
export const nextPhase = (p: Pomodoro): Phase => p.phase === 'focus' ? (p.rounds > 0 && p.rounds % 4 === 0 ? 'long' : 'short') : 'focus';
export const remainingTime = (p: Pomodoro, now: number) => p.status === 'running' ? Math.max(0, (p.endsAt ?? now) - now) : p.remainingMs;
export function advanceWellness(state: WellnessState, now: number): WellnessState {
  const p = state.pomodoro;
  if (p.status !== 'running' || p.endsAt === null || p.endsAt > now) return state;
  return { ...state, pomodoro: { ...p, status: 'finished', remainingMs: 0, rounds: p.rounds + (p.phase === 'focus' ? 1 : 0) } };
}
export function reduceWellness(state: WellnessState, action: WellnessAction, now: number): WellnessState {
  state = advanceWellness(state, now);
  if ('kind' in action) {
    const r = { ...state[action.kind] };
    if (action.type === 'interval') {
      if (!validMinutes(action.minutes)) return state;
      r.intervalMin = action.minutes;
    }
    if (action.type === 'enable') r.enabled = action.enabled;
    r.nextAt = r.enabled ? now + (action.type === 'snooze' ? 5 : r.intervalMin) * 60_000 : null;
    return { ...state, [action.kind]: r, exercise: state.exercise + (action.type === 'done' && action.kind === 'stretch' ? 1 : 0) };
  }
  const p = { ...state.pomodoro, durations: { ...state.pomodoro.durations } };
  if (action.type === 'duration') {
    if (p.status !== 'idle' || !validMinutes(action.minutes)) return state;
    p.durations[action.phase] = action.minutes;
    p.remainingMs = p.durations[p.phase] * 60_000;
  } else if (action.type === 'phase' || action.type === 'reset') {
    if (action.type === 'phase') p.phase = action.phase;
    p.status = 'idle'; p.endsAt = null; p.remainingMs = p.durations[p.phase] * 60_000;
  } else if (action.type === 'start') {
    if (p.status !== 'idle' && p.status !== 'paused') return state;
    p.endsAt = now + p.remainingMs; p.status = 'running';
  } else if (action.type === 'pause') {
    if (p.status !== 'running') return state;
    p.remainingMs = remainingTime(p, now); p.endsAt = null; p.status = 'paused';
  } else if (action.type === 'next') {
    if (p.status !== 'finished') return state;
    p.phase = nextPhase(p); p.remainingMs = p.durations[p.phase] * 60_000; p.endsAt = now + p.remainingMs; p.status = 'running';
  }
  return { ...state, pomodoro: p };
}
/** Storage is untrusted. Keep valid deadlines (including overdue ones), never invent a running timer. */
export function restoreWellness(value: unknown, now: number): WellnessState {
  const out = createWellness();
  if (!value || typeof value !== 'object' || (value as WellnessState).version !== 1) return out;
  const v = value as Partial<WellnessState>;
  for (const kind of ['water', 'stretch'] as const) {
    const r = v[kind];
    if (!r || typeof r !== 'object') continue;
    if (validMinutes(r.intervalMin)) out[kind].intervalMin = r.intervalMin;
    out[kind].enabled = r.enabled === true;
    out[kind].nextAt = out[kind].enabled ? (validTime(r.nextAt) ? r.nextAt : now + out[kind].intervalMin * 60_000) : null;
  }
  if (Number.isSafeInteger(v.exercise) && v.exercise! >= 0) out.exercise = v.exercise! % EXERCISES.length;
  const p = v.pomodoro;
  if (p && typeof p === 'object') {
    const dest = out.pomodoro;
    if (['focus', 'short', 'long'].includes(p.phase)) dest.phase = p.phase;
    for (const phase of ['focus', 'short', 'long'] as const) if (validMinutes(p.durations?.[phase])) dest.durations[phase] = p.durations[phase];
    dest.remainingMs = dest.durations[dest.phase] * 60_000;
    if (Number.isSafeInteger(p.rounds) && p.rounds >= 0) dest.rounds = p.rounds;
    if ((p.status === 'running' || p.status === 'finished') && validTime(p.endsAt)) {
      dest.status = p.status; dest.endsAt = p.endsAt;
      // A running countdown is derived from endsAt. Preserve the saved remainder so storage events
      // between tabs cannot continually rewrite each other with a slightly newer wall clock.
      dest.remainingMs = p.status === 'finished' ? 0 : validTime(p.remainingMs) && p.remainingMs > 0 && p.remainingMs <= dest.remainingMs ? p.remainingMs : dest.remainingMs;
    } else if (p.status === 'paused' && validTime(p.remainingMs) && p.remainingMs > 0 && p.remainingMs <= dest.remainingMs) {
      dest.status = 'paused'; dest.remainingMs = p.remainingMs;
    }
  }
  return advanceWellness(out, now);
}
export function wellnessRequests(state: WellnessState): WellnessRequest[] {
  const requests: WellnessRequest[] = [];
  if (state.water.enabled && state.water.nextAt !== null) requests.push({ kind: 'water', at: state.water.nextAt, title: 'Time for water', body: 'Take a moment to drink some water.' });
  if (state.stretch.enabled && state.stretch.nextAt !== null) requests.push({ kind: 'stretch', at: state.stretch.nextAt, title: 'Time to stretch', body: EXERCISES[state.exercise % EXERCISES.length].name + ' · Take a short movement break.' });
  const p = state.pomodoro;
  if ((p.status === 'running' || p.status === 'finished') && p.endsAt !== null) requests.push({ kind: 'pomodoro', at: p.endsAt,
    title: p.phase === 'focus' ? 'Focus session complete' : 'Break is over', body: p.phase === 'focus' ? 'Nice work. Take a break when you are ready.' : 'Ready for another focus session?' });
  return requests;
}
export const pendingWellness = (state: WellnessState, now: number): WellnessKind[] => wellnessRequests(state).filter(r => r.at <= now).sort((a, b) => a.at - b.at).map(r => r.kind);
