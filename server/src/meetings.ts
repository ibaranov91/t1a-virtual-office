// Calendar meetings: who's in which meeting now or soon, merged from every connected Google Calendar.
// One connected attendee is enough: everyone on the event's guest list (by sign-in email) gets the heads-up,
// shows as "in a meeting" and can step into the meeting's room.
import { createHash } from 'node:crypto';
import type { AgendaItem } from '../../shared/protocol';
import { CALENDAR_SCOPE, forgetAccess, listMeetings, type CalMeeting } from './google';
import type { User, World } from './world';

const POLL_MS = 2 * 60_000;   // calendars change rarely; heads-ups are worked out from start times client-side
const AHEAD_MS = 70 * 60_000; // what counts as "soon"
const EARLY_MS = 10 * 60_000; // you can step into a meeting's room this long before it starts

export interface Meeting extends CalMeeting { instance: string; owners: Set<string> } // owners: whose calendars it came from

export class Meetings {
  events = new Map<string, Meeting>();
  private sent = new Map<string, string>(); // userId -> last agenda sent, to skip repeats
  private left = new Map<string, Set<string>>(); // userId -> meetings they left for good (in memory, like the rooms)
  private polling = false;
  constructor(private world: World) {
    setTimeout(() => void this.poll(), 5_000); // soon after a restart
    setInterval(() => void this.poll(), POLL_MS);
    setInterval(() => this.tick(), 15_000);
  }
  static instanceOf = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 10);

  /** Re-read every connected calendar. Soon after someone connects, too. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const next = new Map<string, Meeting>();
      for (const u of this.world.users.values()) {
        const g = u.google;
        if (!g?.scopes.includes(CALENDAR_SCOPE)) continue;
        try {
          for (const m of await listMeetings(u.id, g, AHEAD_MS)) {
            const have = next.get(m.key);
            if (have) { have.owners.add(u.id); have.link ??= m.link; for (const e of m.emails) if (!have.emails.includes(e)) have.emails.push(e); }
            else next.set(m.key, { ...m, instance: Meetings.instanceOf(m.key), owners: new Set([u.id]) });
          }
        } catch (e) {
          const err = e as Error & { code?: string };
          console.warn(`google: meetings for ${u.name}:`, err.message);
          if (err.code === 'invalid_grant' && u.google === g) { u.google = undefined; forgetAccess(u.id); this.world.sendTo(u.id, this.world.me(u)); }
          for (const [k, m] of this.events) if (m.owners.has(u.id) && !next.has(k)) next.set(k, m); // keep what we knew
        }
      }
      this.events = next;
    } finally { this.polling = false; }
    this.tick();
  }

  /** Deck people on this meeting's guest list (or whose calendar it's from). */
  attendees(m: Meeting): User[] {
    return [...this.world.users.values()].filter(u => !u.bot && (m.owners.has(u.id) || (!!u.email && m.emails.includes(u.email))));
  }
  canEnter(u: User, m: Meeting, now = Date.now()) { return now >= m.start - EARLY_MS && now < m.end && this.attendees(m).includes(u); }
  hasLeft(u: User, key: string) { return this.left.get(u.id)?.has(key) ?? false; }
  /** Leave a meeting for good: out of its room, no longer busy, knocks come through again. Go puts you back in. */
  leave(u: User, key: string) {
    const m = this.events.get(key);
    if (!m || !this.attendees(m).includes(u)) return;
    let keys = this.left.get(u.id);
    if (!keys) this.left.set(u.id, (keys = new Set()));
    keys.add(key);
    if (u.instance === m.instance) this.world.leaveMeeting(u);
    this.tick();
  }
  rejoin(u: User, key: string) { if (this.left.get(u.id)?.delete(key)) this.tick(); }

  agendaOf(u: User, now = Date.now()): AgendaItem[] {
    return [...this.events.values()].filter(m => m.end > now && this.attendees(m).includes(u)).sort((a, b) => a.start - b.start)
      .map(m => ({ key: m.key, instance: m.instance, title: m.title, start: m.start, end: m.end, link: m.link, left: this.hasLeft(u, m.key) || undefined }));
  }
  /** Send this person their agenda if it changed (force: e.g. a fresh page). */
  sendAgenda(u: User, force = false) {
    const items = this.agendaOf(u), json = JSON.stringify(items);
    if (!force && this.sent.get(u.id) === json) return;
    this.sent.set(u.id, json);
    this.world.sendTo(u.id, { t: 'agenda', items });
  }

  /** Busy flags, agendas and meeting rooms follow the clock. */
  tick(now = Date.now()) {
    for (const [k, m] of this.events) if (m.end <= now) { this.events.delete(k); for (const keys of this.left.values()) keys.delete(k); }
    const busy = new Map<string, number>();
    for (const m of this.events.values()) {
      if (m.start > now) continue;
      for (const u of this.attendees(m)) if (!this.hasLeft(u, m.key)) busy.set(u.id, Math.max(busy.get(u.id) ?? 0, m.end));
    }
    for (const u of this.world.users.values()) {
      if (!u.bot) this.world.setMeeting(u, busy.get(u.id) ?? null);
      if (u.presence !== 'offline') this.sendAgenda(u);
    }
    this.world.endMeetings(now);
  }
}
