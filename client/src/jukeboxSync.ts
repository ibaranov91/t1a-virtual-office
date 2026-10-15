export function seekTarget(expected: number, lead: number, trackDurationS: number, elDurationS: number) {
  const end = Number.isFinite(elDurationS) ? Math.min(trackDurationS, elDurationS) : trackDurationS;
  return Math.max(0, Math.min(expected + lead, Math.max(0, end - .05)));
}
export const learnLead = (lead: number, drift: number) => Math.max(0, Math.min(1, lead - drift));
export const playbackRateFor = (drift: number) => Math.abs(drift) < .03 ? 1 : 1 - Math.max(-.05, Math.min(.05, drift * .25));
export const canTeachLead = (ranges: [number, number][], target: number) =>
  ranges.some(([start, end]) => target >= start && target + .5 <= end);
