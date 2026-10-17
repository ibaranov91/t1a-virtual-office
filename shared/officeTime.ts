// Office time: shared events (daily limits, spawns, NPC schedules) follow one zone so everyone sees the same world.
export const OFFICE_TZ = 'Europe/Berlin';
/** The office calendar day, e.g. "2026-10-18", for daily limits and spawns. */
export function officeDay(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
/** Minutes since office midnight (0–1439), for schedules. */
export function officeMinutes(now = Date.now()): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: OFFICE_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(p.find(x => x.type === 'hour')!.value) * 60 + Number(p.find(x => x.type === 'minute')!.value);
}
