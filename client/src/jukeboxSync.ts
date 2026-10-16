import type { JukeboxState } from '../../shared/protocol';
export function seekTarget(expected: number, lead: number, trackDurationS: number, elDurationS: number) {
  const end = Number.isFinite(elDurationS) ? Math.min(trackDurationS, elDurationS) : trackDurationS;
  return Math.max(0, Math.min(expected + lead, Math.max(0, end - .05)));
}
export const learnLead = (lead: number, drift: number) => Math.max(0, Math.min(1, lead - drift));
export const canTeachLead = (ranges: [number, number][], target: number) =>
  ranges.some(([start, end]) => target >= start && target + .5 <= end);

// The jukebox plays through a gate (a GainNode). It starts closed, opens once the element's clock really moves near the
// server position, and dips around corrections. playbackRate is never touched: WebKit stalls ~0.5 s on every rate change.
export const SETTLE_MS = 1000;  // a clock reading counts only this long after play()/seek (WebKit re-anchors currentTime ~0.5–0.8 s in)...
export const STEADY_MS = 500;   // ...and after the clock has advanced this long without a break
export const OPEN_MS = 150;     // a start with a learned lead opens after advancing this long
export const STALL_AHEAD = 1;   // before settling, a reading behind by more than LIVE_DRIFT is a stall's leftover and one ahead by
                                // more than this is off too: seek (silently). WebKit's early readings run up to ~0.4 s ahead
export const CLOSE_DRIFT = .08; // a settled start opens this close to the server position
export const LIVE_DRIFT = .1;   // while sounding, a settled reading further off than this is corrected with a dipped seek
export const MAX_SILENT_SEEKS = 3;
export type Phase = 'starting' | 'live';
export interface ClockInput {
  phase: Phase; advancingMs: number; sinceStartMs: number; drift: number; trusted: boolean; seeks: number;
}
export type ClockAction = { kind: 'wait' } | { kind: 'open'; learn: boolean } | { kind: 'seek'; learn: boolean } | { kind: 'hold'; learn: true };
export function clockStep(i: ClockInput): ClockAction {
  if (i.advancingMs === 0) return { kind: 'wait' }; // never act on a clock that isn't moving (a seek there restarts the wait)
  const settled = i.sinceStartMs >= SETTLE_MS && i.advancingMs >= STEADY_MS;
  if (i.phase === 'starting') {
    if (!settled) {
      if (i.drift < -LIVE_DRIFT || i.drift > STALL_AHEAD) {
        if (i.seeks < MAX_SILENT_SEEKS) return { kind: 'seek', learn: false };
        return i.advancingMs >= OPEN_MS ? { kind: 'open', learn: false } : { kind: 'wait' };
      }
      return i.trusted && i.advancingMs >= OPEN_MS ? { kind: 'open', learn: false } : { kind: 'wait' };
    }
    return Math.abs(i.drift) <= CLOSE_DRIFT || i.seeks >= MAX_SILENT_SEEKS ? { kind: 'open', learn: true } : { kind: 'seek', learn: true };
  }
  if (!settled) return { kind: 'wait' };
  return Math.abs(i.drift) > LIVE_DRIFT ? { kind: 'seek', learn: true } : { kind: 'hold', learn: true };
}
export function isAdvancing(prev: { ct: number; at: number }, ct: number, at: number, rate: number): boolean {
  const elapsed = rate * (at - prev.at) / 1000, delta = ct - prev.ct;
  return at > prev.at && delta >= .5 * elapsed && delta <= 2 * elapsed + .05;
}
export interface Play {
  key: string; track: string; startedAt: number; paused: boolean; positionMs: number;
  endsAt: number; next?: string; predicted: boolean;
}
export function currentPlay(state: JukeboxState | undefined, durationMs: (id: string) => number | undefined, now: number): Play | null {
  if (!state) return null;
  const duration = durationMs(state.track);
  if (duration === undefined) return null;
  const { track, startedAt, next, pausedAt } = state;
  if (pausedAt !== null) return { key: `${track}@paused`, track, startedAt, paused: true, positionMs: pausedAt, endsAt: Infinity, next, predicted: false };
  const end = startedAt + duration;
  if (now < end) return { key: `${track}@${startedAt}`, track, startedAt, paused: false,
    positionMs: Math.max(0, Math.min(duration, now - startedAt)), endsAt: end, next, predicted: false };
  const nextDuration = next === undefined ? undefined : durationMs(next);
  if (next !== undefined && nextDuration !== undefined && now < end + nextDuration)
    return { key: `${next}@${end}`, track: next, startedAt: end, paused: false,
      positionMs: now - end, endsAt: end + nextDuration, next: undefined, predicted: true };
  return null;
}
