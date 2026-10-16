import { currentVacation, type Vacation } from '../../shared/vacation';
import { CALENDAR_SCOPE, forgetAccess, googleEnabled, listAbsences } from './google';
import type { User, World } from './world';

export class Vacations {
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
      for (const u of this.world.users.values()) {
        if (u.bot || !u.email) continue;
        const own = !!u.google?.scopes.includes(CALENDAR_SCOPE);
        const candidates = own ? [u] : this.readers();
        for (const reader of candidates) {
          const link = reader.google;
          if (!link?.scopes.includes(CALENDAR_SCOPE)) continue;
          try {
            const result = await listAbsences(reader.id, link, own ? 'primary' : u.email, own);
            this.set(u.id, currentVacation(result.items, result.timeZone));
            break;
          } catch (e) {
            const err = e as Error & { code?: string; status?: number };
            if (err.code === 'invalid_grant') {
              this.forget(reader, link);
              if (!own) continue;
            } else if (err.status === 403 || err.status === 404) {
              if (!this.denied.has(u.id)) { console.warn(`google: vacations for ${u.name}: calendar unavailable (${err.status})`); this.denied.add(u.id); }
              this.set(u.id, null);
            } else console.warn(`google: vacations for ${u.name}:`, err.message);
            break; // transient errors keep the last known result
          }
        }
      }
    } finally { this.polling = false; }
    this.tick();
  }
}
