import { hash } from './hash';
export const ADJECTIVES = ['Feral', 'Quantum', 'Sleepy', 'Turbo', 'Agile', 'Cosmic', 'Brave', 'Caffeinated', 'Daring', 'Electric', 'Flying', 'Golden', 'Happy', 'Icy', 'Jolly', 'Keen', 'Lucky', 'Mighty', 'Neon', 'Odd', 'Pixel', 'Quiet', 'Rapid', 'Sneaky', 'Tidy', 'Ultra', 'Velvet', 'Wild', 'Zesty', 'Bold', 'Clever', 'Dizzy', 'Epic', 'Fancy', 'Gentle', 'Hungry', 'Instant', 'Jazzy', 'Lunar', 'Magic'];
export const NOUNS = ['Staplers', 'Interns', 'Spreadsheets', 'Ficuses', 'Keyboards', 'Mugs', 'Monitors', 'Printers', 'Postits', 'Calendars', 'Chairs', 'Desks', 'Folders', 'Pencils', 'Pixels', 'Breaks', 'Biscuits', 'Tickets', 'Sprints', 'Standups', 'Branches', 'Commits', 'Tabs', 'Cursors', 'Headsets', 'Notebooks', 'Plants', 'Sockets', 'Packets', 'Servers', 'Queries', 'Dashboards', 'Badges', 'Sandwiches', 'Donuts', 'Teapots', 'Slippers', 'Bookmarks', 'Whiteboards', 'Penguins'];
export const crewKey = (ids: string[]) => JSON.stringify([...ids].sort());
export function autoName(key: string, rerolls = 0): string { const h = hash([key, rerolls]); return `${ADJECTIVES[h % 40]} ${NOUNS[Math.trunc(h / 40) % 40]}`; }
export function crewName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return [...name].length >= 1 && [...name].length <= 20 && /^[\p{L}\p{N} '\-!&.]+$/u.test(name) && !/\b(fuck|shit|nazi|hitler)\b/i.test(name) ? name : null;
}
export function balanceTeams(players: { userId: string; slot: number }[], points: Record<string, number>) {
  const ranked = [...players].sort((a, b) => (points[b.userId] ?? 0) - (points[a.userId] ?? 0) || a.slot - b.slot);
  return players.map(p => ({ ...p, team: ([0, 3].includes(ranked.findIndex(q => q.userId === p.userId)) ? 0 : 1) as 0 | 1 }));
}
