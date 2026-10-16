import { ACHIEVEMENTS, BOTANIST_KINDS, BOOKWORM_READS, EDITOR_READERS, PLANT_STAGES, plantDead, type Achievement, type LibraryState, type PublicUser } from '../../shared/protocol';

export interface AchievementContext {
  me: Pick<PublicUser, 'id' | 'plant' | 'bloomed' | 'achievements'>;
  now: number;
  library: LibraryState;
}
export function progressOf(a: Achievement, { me, now, library }: AchievementContext): { n: number; goal: number } | null {
  if (me.achievements[a.id] !== undefined || a.soon) return null;
  switch (a.id) {
    case 'bloom': return me.plant && !plantDead(me.plant, now) ? { n: me.plant.stage, goal: PLANT_STAGES.length - 1 } : null;
    case 'botanist': return { n: new Set(me.bloomed).size, goal: BOTANIST_KINDS };
    case 'bookworm': return { n: new Set(library.reads.filter(r => r.done && r.userId === me.id).map(r => r.articleId)).size, goal: BOOKWORM_READS };
    case 'editor': return { n: Math.max(0, ...library.articles.filter(a => a.by === me.id).map(a =>
      new Set(library.reads.filter(r => r.done && r.articleId === a.id && r.userId !== me.id).map(r => r.userId)).size)), goal: EDITOR_READERS };
    default: return null;
  }
}
type RosterUser = Pick<PublicUser, 'bot' | 'achievements'>;
export function rarityOf(id: string, users: Iterable<RosterUser> | ReadonlyMap<string, RosterUser>): { has: number; total: number; pct: number } | null {
  const roster = 'values' in users ? [...users.values()] : [...users];
  const humans = roster.filter(u => !u.bot), total = humans.length;
  if (total < 3) return null;
  const has = humans.filter(u => u.achievements[id] !== undefined).length;
  return { has, total, pct: Math.round(has / total * 100) };
}
export function summary(me: AchievementContext['me'], ctx: AchievementContext) {
  const available = ACHIEVEMENTS.filter(a => !a.soon);
  const unlocked = available.filter(a => me.achievements[a.id] !== undefined);
  const newest = [...unlocked].sort((a, b) => me.achievements[b.id] - me.achievements[a.id])[0];
  let next: { a: Achievement; n: number; goal: number } | null = null;
  for (const a of available) {
    const p = progressOf(a, { ...ctx, me });
    if (p && (!next || p.n / p.goal > next.n / next.goal)) next = { a, ...p };
  }
  return { unlocked: unlocked.length, total: available.length, latest: newest ? { a: newest, at: me.achievements[newest.id] } : null, next };
}
export function sections(me: AchievementContext['me'], ctx: AchievementContext): { id: 'unlocked' | 'locked'; items: Achievement[] }[] {
  const unlocked = ACHIEVEMENTS.filter(a => me.achievements[a.id] !== undefined);
  const locked = ACHIEVEMENTS.filter(a => me.achievements[a.id] === undefined);
  const rank = (a: Achievement) => a.soon ? 3 : a.secret ? 2 : progressOf(a, { ...ctx, me }) ? 0 : 1;
  const fraction = (a: Achievement) => { const p = progressOf(a, { ...ctx, me }); return p ? p.n / p.goal : 0; };
  return [
    { id: 'unlocked', items: unlocked.sort((a, b) => me.achievements[b.id] - me.achievements[a.id]) },
    { id: 'locked', items: locked.sort((a, b) => rank(a) - rank(b) || fraction(b) - fraction(a)) },
  ];
}
