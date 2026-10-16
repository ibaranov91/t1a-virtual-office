import type { ArcadeBoards, Week } from './types';
const warsaw = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });
export function weekKey(at: number): string {
  const p = Object.fromEntries(warsaw.formatToParts(new Date(at)).map(p => [p.type, p.value]));
  // Calendar arithmetic on the Warsaw date, never 168 hours subtracted from an instant.
  const date = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export const emptyWeek = (key: string): Week => ({ key, players: {}, champions: {}, oracle: {}, table: {} });
export const weeklyTotal = (p: Week['players'][string]) => p.sets.reduce((n, s) => n + s.total, 0);
export function ranked(values: Record<string, number>): { userId: string; value: number; rank: number }[] {
  const sorted = Object.entries(values).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let rank = 0;
  return sorted.map(([userId, value], i) => { if (i === 0 || value !== sorted[i - 1][1]) rank = i + 1; return { userId, value, rank }; });
}
export function rollover(boards: ArcadeBoards, at: number): boolean {
  const key = weekKey(at); if (boards.week.key === key) return false;
  const top = ranked(Object.fromEntries(Object.entries(boards.week.players).map(([id, p]) => [id, weeklyTotal(p)]))).filter(r => r.rank === 1);
  const entries = top.map(r => ({ week: boards.week.key, userId: r.userId, name: boards.week.players[r.userId].name, points: r.value }));
  boards.hall = [...boards.hall, ...entries].slice(-10); boards.week = emptyWeek(key); return true;
}
