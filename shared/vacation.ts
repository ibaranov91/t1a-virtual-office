/** Calendar absence data deliberately contains no titles or other event details. */
export interface Absence { start: number; end: number; allDay?: { endDate: string } }
export interface Vacation { until: number; back?: string }
const formatters = new Map<string, Intl.DateTimeFormat>();
function local(ms: number, zone: string) {
  let f = formatters.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); formatters.set(zone, f); }
  const p = Object.fromEntries(f.formatToParts(ms).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, second: +p.second };
}
/** Local calendar time to epoch ms, including the zone's daylight-saving offset on that date. */
export function zonedTime(date: string, zone: string, hour = 0, minute = 0): number {
  const target = Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60000;
  let ms = target;
  for (let i = 0; i < 4; i++) {
    const p = local(ms, zone), represented = Date.parse(`${p.date}T00:00:00Z`) + ((p.hour * 60 + p.minute) * 60 + p.second) * 1000;
    const delta = target - represented;
    if (!delta) break;
    ms += delta;
  }
  return ms;
}
const nextDate = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const weekday = (d: string) => { const n = new Date(`${d}T00:00:00Z`).getUTCDay(); return n !== 0 && n !== 6; };
function workingGap(start: number, end: number, zone: string) {
  if (end <= start) return false;
  const last = local(end, zone).date;
  for (let d = local(start, zone).date; d <= last; d = nextDate(d)) {
    if (weekday(d) && Math.max(start, zonedTime(d, zone, 9)) < Math.min(end, zonedTime(d, zone, 17))) return true;
  }
  return false;
}
export function currentVacation(items: Absence[], timeZone: string, now = Date.now()): Vacation | null {
  const sorted = items.filter(a => Number.isFinite(a.start) && Number.isFinite(a.end) && a.end > a.start && (a.allDay || a.end - a.start >= 6 * 3600000)).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Absence[] = [];
  for (const item of sorted) {
    const prev = merged.at(-1);
    if (!prev || workingGap(prev.end, item.start, timeZone)) merged.push({ ...item });
    else if (item.end >= prev.end) { prev.end = item.end; prev.allDay = item.allDay; }
  }
  const a = merged.find(a => a.start <= now && now < a.end);
  if (!a) return null;
  let back: string;
  if (a.allDay) back = a.allDay.endDate;
  else {
    const p = local(a.end, timeZone);
    if (weekday(p.date) && p.hour >= 9 && p.hour < 17) return { until: a.end };
    back = p.date;
    if (zonedTime(back, timeZone, 9) < a.end) back = nextDate(back);
  }
  while (!weekday(back)) back = nextDate(back);
  return { until: a.end, back };
}
