// Calendar meetings: who's in which meeting now or soon, merged from every connected Google Calendar.
// One connected attendee is enough: everyone on the event's guest list (by sign-in email) gets the heads-up,
// shows as "in a meeting" and can step into the meeting's room.
import { createHash, randomUUID } from 'node:crypto';
import type { AgendaItem } from '../../shared/protocol';
import { CALENDAR_SCOPE, forgetAccess, listMeetings, type CalMeeting } from './google';
import type { User, World } from './world';

const POLL_MS = 2 * 60_000;   // calendars change rarely; heads-ups are worked out from start times client-side
const AHEAD_MS = 70 * 60_000; // what counts as "soon"
const ADHOC_MS = 3 * 3_600_000; // how long a private room lasts at most
export const ADHOC_EMPTY_MS = 2 * 60_000; // a private room nobody's been in for this long is over
const EARLY_MS = 10 * 60_000; // you can step into a meeting's room this long before it starts

export interface Meeting extends CalMeeting { instance: string; owners: Set<string>; adhoc?: { host: string; hostName: string; invited: Set<string>; emptySince?: number } } // owners: whose calendars it came from

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
      for (const [k, m] of this.events) if (m.adhoc) next.set(k, m); // private rooms aren't on any calendar
      this.events = next;
    } finally { this.polling = false; }
    this.tick();
  }

  /** Deck people on this meeting's guest list (or whose calendar it's from). */
  attendees(m: Meeting): User[] {
    return [...this.world.users.values()].filter(u => !u.bot && (m.owners.has(u.id) || !!m.adhoc?.invited.has(u.id) || (!!u.email && m.emails.includes(u.email))));
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

  /** A private room: a Meeting-room copy for the host and whoever they invite, for the next 3 hours. */
  createAdhoc(host: User, title: string, invited: Set<string>, now = Date.now()): Meeting {
    const key = `adhoc:${randomUUID()}`;
    invited.add(host.id);
    const m: Meeting = { key, title, start: now, end: now + ADHOC_MS, emails: [], instance: Meetings.instanceOf(key), owners: new Set(), adhoc: { host: host.id, hostName: host.name, invited } };
    this.events.set(key, m);
    return m;
  }
  /** End a private room now: everyone inside goes back to the office (with `note`), it leaves every agenda. */
  end(m: Meeting, note: string, now = Date.now()) {
    m.end = now;
    this.world.closeInstance(m.instance, now, note);
    this.tick(now);
  }
  /** The private room this person is standing in, if any. */
  adhocOf(u: User): Meeting | undefined {
    return u.instance ? [...this.events.values()].find(m => m.adhoc && m.instance === u.instance) : undefined;
  }
  /** Everyone who can see this private room on their agenda. */
  notify(m: Meeting) { for (const u of this.attendees(m)) if (u.presence !== 'offline') this.sendAgenda(u, true); this.tick(); }

  agendaOf(u: User, now = Date.now()): AgendaItem[] {
    return [...this.events.values()].filter(m => m.end > now && this.attendees(m).includes(u)).sort((a, b) => a.start - b.start)
      .map(m => ({ key: m.key, instance: m.instance, title: m.title, start: m.start, end: m.end, link: m.link, left: this.hasLeft(u, m.key) || undefined, ...(m.adhoc && { adhoc: true, from: m.adhoc.hostName, host: m.adhoc.host === u.id || undefined }) }));
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
    for (const m of this.events.values()) { // a private room everyone has left is over after a short grace (they may step back in)
      if (!m.adhoc || m.start > now) continue;
      if (this.world.inInstance(m.instance)) { delete m.adhoc.emptySince; continue; }
      m.adhoc.emptySince ??= now;
      if (now - m.adhoc.emptySince >= ADHOC_EMPTY_MS) { m.end = now; this.world.closeInstance(m.instance, now, `${m.title} closed: everyone had left`); } // anyone offline inside goes too
    }
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
