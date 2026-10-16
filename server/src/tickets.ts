import { TICKET_MSGS_MAX, TICKET_OPEN_MAX, TICKET_TEXT_MAX, TICKET_TITLE_MAX, type Ticket, type TicketContext, type TicketStatus } from '../../shared/protocol';

const KEPT = 1000;            // over this, the oldest settled tickets drop off
export const TICKET_GAP_MS = 30_000; // one new ticket per person per 30 s
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const line = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
/** Multi-line text: keeps line breaks, trims each line's trailing spaces and runs of blank lines. */
const body = (v: unknown) => typeof v === 'string' ? v.replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : '';
const STATUSES: readonly TicketStatus[] = ['open', 'fixed', 'closed'];

/** The bug terminal's tickets. Private: the World sends each person only what `visibleTo` gives them. */
export class Tickets {
  list: Ticket[] = [];
  private next = 1;
  private lastNew = new Map<string, number>();

  add(by: string, title: unknown, text: unknown, context: unknown, where: Pick<TicketContext, 'room' | 'tile'>, now: number): Ticket | string {
    const name = line(title, Infinity), report = body(text);
    if (!name) return 'Give the bug a title';
    if (name.length > TICKET_TITLE_MAX) return `Keep the title under ${TICKET_TITLE_MAX} characters`;
    if (!report) return 'Describe the bug';
    if (report.length > TICKET_TEXT_MAX) return `Keep it under ${TICKET_TEXT_MAX} characters`;
    if (this.list.filter(t => t.by === by && t.status === 'open').length >= TICKET_OPEN_MAX) return `You have ${TICKET_OPEN_MAX} open tickets already`;
    if (now - (this.lastNew.get(by) ?? -Infinity) < TICKET_GAP_MS) return 'One ticket at a time: try again in a moment';
    const c = record(context);
    const ticket: Ticket = {
      id: this.next++, by, title: name, status: 'open', at: now, updated: now,
      context: { ua: line(c.ua, 200), app: c.app === 'mac' ? 'mac' : 'web', build: line(c.build, 40), viewport: line(c.viewport, 20), ...where },
      msgs: [{ by, admin: false, text: report, at: now }], seen: { [by]: now },
    };
    this.list.push(ticket);
    this.lastNew.set(by, now);
    while (this.list.length > KEPT) {
      const i = this.list.findIndex(t => t.status !== 'open');
      this.list.splice(i < 0 ? 0 : i, 1);
    }
    return ticket;
  }
  get(id: number) { return this.list.find(t => t.id === id); }
  /** The author or an admin adds to the thread. An author's reply on a fixed ticket opens it again. */
  reply(id: number, by: string, admin: boolean, text: unknown, now: number): Ticket | string | null {
    const t = this.get(id), say = body(text);
    if (!t || (t.by !== by && !admin)) return null;
    if (!say) return 'Write something first';
    if (say.length > TICKET_TEXT_MAX) return `Keep it under ${TICKET_TEXT_MAX} characters`;
    if (t.msgs.length >= TICKET_MSGS_MAX) return 'This thread is full: file a new ticket';
    t.msgs.push({ by, admin: admin && t.by !== by, text: say, at: now });
    if (t.by === by && t.status === 'fixed') t.status = 'open';
    t.updated = now; t.seen[by] = now;
    return t;
  }
  /** Admins set any status; an author may only close their own. */
  setStatus(id: number, by: string, admin: boolean, status: unknown, now: number): Ticket | null {
    const t = this.get(id);
    if (!t || !STATUSES.includes(status as TicketStatus) || t.status === status) return null;
    if (!admin && !(t.by === by && status === 'closed')) return null;
    t.status = status as TicketStatus;
    t.msgs.push({ by, admin, text: status === 'open' ? 'reopened' : `marked ${status}`, at: now, system: true });
    t.updated = now; t.seen[by] = now;
    return t;
  }
  seen(id: number, by: string, admin: boolean, now: number) {
    const t = this.get(id);
    if (!t || (t.by !== by && !admin)) return null;
    t.seen[by] = now; return t;
  }
  visibleTo(userId: string, admin: boolean) { return admin ? this.list : this.list.filter(t => t.by === userId); }

  dump() { return { next: this.next, list: this.list }; }
  load(raw: unknown) {
    const d = record(raw);
    this.list = Array.isArray(d.list) ? (d.list as Ticket[]).filter(t => Number.isInteger(t?.id) && typeof t.by === 'string' && Array.isArray(t.msgs)) : [];
    this.next = Math.max(Number.isInteger(d.next) ? d.next as number : 1, ...this.list.map(t => t.id + 1));
  }
}
