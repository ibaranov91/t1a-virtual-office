import { currentVacation, zonedTime, type Absence, type Vacation } from '../../shared/vacation';
import { CALENDAR_SCOPE, forgetAccess, googleEnabled, listAbsences, listTeamAbsences, type TeamAbsence } from './google';
import type { User, World } from './world';

const DEFAULT_TEAM_CALENDAR = 't1a.com_aoas0mu6l5d0hmrdhabm01rc0k@group.calendar.google.com';
const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
let teamFailureLogged = false;

export class Vacations {
  private team: TeamAbsence[] = [];
  private polling = false;
  private bots = false;
  private denied = new Set<string>();
  private started = Date.now();
  private fake = new Map((process.env.VACATION_FAKE ?? '').split(',').flatMap(part => {
    const [name, days] = part.split(':');
    return name?.trim() && Number.isFinite(Number(days)) && Number(days) > 0 ? [[name.trim().toLowerCase(), this.started + Number(days) * 86400000] as const] : [];
  }));
  constructor(private world: World, private enabled = googleEnabled) {
    if (enabled) {
      this.soon();
      setInterval(() => void this.poll(), 10 * 60000).unref();
    }
    setInterval(() => this.tick(), 15000).unref();
  }
  soon() { if (this.enabled) setTimeout(() => void this.poll(), 5000).unref(); }
  set(userId: string, vacation: Vacation | null) {
    const u = this.world.users.get(userId);
    if (u) this.world.setVacation(u, vacation);
  }
  syncDev(bots = false) {
    this.bots ||= bots;
    if (this.enabled) return;
    const now = Date.now();
    if (this.bots && process.env.VACATION_BOTS !== '0') {
      const bots = [...this.world.users.values()].filter(u => u.bot).slice(-2);
      bots.forEach((u, i) => {
        if (u.vacation && u.vacation.until > now) return;
        this.world.setPresence(u, 'offline');
        this.set(u.id, { until: now + (i === 0 ? 3 : 9) * 86400000 });
      });
    }
    for (const u of this.world.users.values()) {
      const until = this.fake.get(u.name.toLowerCase());
      if (until && until > now) this.set(u.id, { until });
    }
  }
  tick() {
    this.syncDev();
    const now = Date.now();
    for (const u of this.world.users.values()) if (u.vacation && u.vacation.until <= now) this.set(u.id, null);
  }
  private readers() {
    const admins = (process.env.DECK_ADMINS ?? '').toLowerCase().split(',').map(e => e.trim());
    const users = [...this.world.users.values()].filter(u => !u.bot && !!u.google?.scopes.includes(CALENDAR_SCOPE));
    return [...users.filter(u => !!u.email && admins.includes(u.email.toLowerCase())), ...users.filter(u => !u.email || !admins.includes(u.email.toLowerCase()))];
  }
  private forget(u: User, link: NonNullable<User['google']>) {
    if (u.google !== link) return;
    u.google = undefined; forgetAccess(u.id); this.world.sendTo(u.id, this.world.me(u));
  }
  async poll() {
    if (!this.enabled || this.polling) return;
    this.polling = true;
    try {
      const calendarId = process.env.VACATION_TEAM_CALENDAR ?? DEFAULT_TEAM_CALENDAR;
      if (calendarId) {
        let succeeded = false;
        for (const reader of this.readers()) {
          const link = reader.google!;
          try {
            this.team = (await listTeamAbsences(reader.id, link, calendarId)).items;
            succeeded = true;
            break;
          } catch (e) {
            const err = e as Error & { code?: string; status?: number };
            if (err.code === 'invalid_grant') this.forget(reader, link);
          }
        }
        if (!succeeded && !teamFailureLogged) {
          console.warn('google: team vacations unavailable; keeping last successful result');
          teamFailureLogged = true;
        }
      }
      for (const u of this.world.users.values()) {
        if (u.bot || !u.email) continue;
        const team = calendarId ? this.team.filter(a => a.who.emails.includes(u.email!.toLowerCase()) || normalize(a.who.name) === normalize(u.name) || normalize(a.who.name) === normalize(u.email!.split('@')[0].replace(/[._]/g, ' '))) : [];
        let result: { timeZone: string; items: Absence[] } | undefined;
        let clear = false;
        const own = !!u.google?.scopes.includes(CALENDAR_SCOPE);
        const candidates = own ? [u] : this.readers();
        for (const reader of candidates) {
          const link = reader.google;
          if (!link?.scopes.includes(CALENDAR_SCOPE)) continue;
          try {
            result = await listAbsences(reader.id, link, own ? 'primary' : u.email, own);
            break;
          } catch (e) {
            const err = e as Error & { code?: string; status?: number };
            if (err.code === 'invalid_grant') {
              this.forget(reader, link);
              if (!own) continue;
            } else if (err.status === 403 || err.status === 404) {
              if (!this.denied.has(u.id)) { console.warn(`google: vacations for ${u.name}: calendar unavailable (${err.status})`); this.denied.add(u.id); }
              clear = true;
            } else console.warn(`google: vacations for ${u.name}:`, err.message);
            break; // transient errors keep the last known result
          }
        }
        if (result || clear || team.length) {
          const tz = result?.timeZone ?? u.tz ?? 'Europe/Warsaw';
          const items: Absence[] = team.map(a => ({
            start: typeof a.start === 'string' ? zonedTime(a.start, tz) : a.start,
            end: typeof a.end === 'string' ? zonedTime(a.end, tz) : a.end,
            ...(typeof a.end === 'string' ? { allDay: { endDate: a.end } } : {}),
          }));
          this.set(u.id, currentVacation([...(result?.items ?? []), ...items], tz));
        }
      }
    } finally { this.polling = false; }
    this.tick();
  }
}
