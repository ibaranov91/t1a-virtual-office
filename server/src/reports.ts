// Client error reports (reuse DiagStore: per-day jsonl, 3-day retention) and "Report bug" submissions.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DiagError } from './diag';

export const BUG_MAX_BYTES = 1.5 * 1024 * 1024, SHOT_MAX_BYTES = 1024 * 1024, BUG_DAYS = 14, BUG_EVENTS = 200;
const DAY = 86400_000, BUG_ID = /^[0-9a-f]{16}$/;
export interface BugEvent { at: number; k: string; s: string }
export interface Bug {
  id: string; at: number; user: string; name: string; note: string; page: string; ua: string;
  versions: Record<string, string>; events: BugEvent[]; shot: 'png' | 'jpg' | null;
}
const str = (v: unknown, max: number, what: string) => {
  if (typeof v !== 'string' || v.length > max) throw new DiagError(400, `Invalid ${what}`);
  return v;
};

/** Checks a client error batch: a few short records, nothing else. */
export function validateErrors(value: unknown) {
  const b = value as { page?: unknown; ua?: unknown; build?: unknown; records?: unknown } | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.records) || b.records.length > 50) throw new DiagError(400, 'Invalid error report');
  const records = b.records.map(r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new DiagError(400, 'Invalid error report');
    const e = r as Record<string, unknown>;
    return { type: 'error', kind: str(e.kind ?? 'error', 20, 'kind'), msg: str(e.msg ?? '', 500, 'message'), stack: str(e.stack ?? '', 2000, 'stack'),
      src: str(e.src ?? '', 300, 'source'), line: Number(e.line) || 0, col: Number(e.col) || 0, at: Number(e.at) || 0, build: str(b.build ?? '', 80, 'build'), count: Math.min(999, Number(e.count) || 1) };
  });
  return { page: str(b.page ?? '', 40, 'page'), ua: str(b.ua ?? '', 400, 'ua'), records };
}

/** Checks a bug report; the screenshot arrives as a data URL, PNG or JPEG. */
export function validateBug(value: unknown) {
  const b = value as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new DiagError(400, 'Invalid bug report');
  const note = str(b.note ?? '', 1000, 'note').trim();
  if (!note) throw new DiagError(400, 'Say what went wrong');
  const events = b.events ?? [];
  if (!Array.isArray(events) || events.length > BUG_EVENTS * 2) throw new DiagError(400, 'Invalid events');
  const clean: BugEvent[] = events.slice(-BUG_EVENTS).map(e => {
    const x = e as Record<string, unknown>;
    return { at: Number(x?.at) || 0, k: str(x?.k ?? '', 12, 'event'), s: str(x?.s ?? '', 300, 'event') };
  });
  const versions: Record<string, string> = {};
  if (b.versions && typeof b.versions === 'object') for (const [k, v] of Object.entries(b.versions).slice(0, 12)) versions[k.slice(0, 20)] = String(v).slice(0, 80);
  let shot: { ext: 'png' | 'jpg'; data: Buffer } | null = null;
  if (b.screenshot) {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(str(b.screenshot, SHOT_MAX_BYTES * 2, 'screenshot'));
    if (!m) throw new DiagError(400, 'Invalid screenshot');
    const data = Buffer.from(m[2], 'base64'), ok = m[1] === 'png' ? data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) : data[0] === 0xff && data[1] === 0xd8;
    if (!ok) throw new DiagError(400, 'Invalid screenshot');
    if (data.length > SHOT_MAX_BYTES) throw new DiagError(413, 'Screenshot too large');
    shot = { ext: m[1] === 'png' ? 'png' : 'jpg', data };
  }
  return { note, events: clean, versions, page: str(b.page ?? '', 40, 'page'), ua: str(b.ua ?? '', 400, 'ua'), shot };
}

export class BugStore {
  private last = new Map<string, number>();
  constructor(private root: string) {}
  async submit(user: { id: string; name: string }, report: ReturnType<typeof validateBug>, now = Date.now()) {
    const prev = this.last.get(user.id);
    if (prev !== undefined && now - prev < 10_000) throw new DiagError(429, 'One report every 10 seconds');
    this.last.set(user.id, now);
    const id = randomBytes(8).toString('hex'), dir = join(this.root, new Date(now).toISOString().slice(0, 10));
    await mkdir(dir, { recursive: true });
    const bug: Bug = { id, at: now, user: user.id, name: user.name, note: report.note, page: report.page, ua: report.ua, versions: report.versions, events: report.events, shot: report.shot?.ext ?? null };
    if (report.shot) await writeFile(join(dir, `${id}.${report.shot.ext}`), report.shot.data);
    await writeFile(join(dir, `${id}.json`), JSON.stringify(bug));
    return id;
  }
  /** Newest first. */
  async list(limit = 50): Promise<Bug[]> {
    const days = (await readdir(this.root).catch(() => [] as string[])).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
    const out: Bug[] = [];
    for (const day of days) {
      const files = (await readdir(join(this.root, day)).catch(() => [] as string[])).filter(f => f.endsWith('.json'));
      const bugs: Bug[] = [];
      for (const f of files) try { bugs.push(JSON.parse(await readFile(join(this.root, day, f), 'utf8'))); } catch { /* half-written file */ }
      out.push(...bugs.sort((a, b) => b.at - a.at));
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }
  async screenshot(id: string): Promise<{ type: string; data: Buffer } | null> {
    if (!BUG_ID.test(id)) return null;
    const days = (await readdir(this.root).catch(() => [] as string[])).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const day of days) for (const ext of ['png', 'jpg'] as const) {
      const data = await readFile(join(this.root, day, `${id}.${ext}`)).catch(() => null);
      if (data) return { type: ext === 'png' ? 'image/png' : 'image/jpeg', data };
    }
    return null;
  }
  async sweep(now = Date.now()) {
    for (const [k, at] of this.last) if (now - at >= 10_000) this.last.delete(k);
    const cutoff = new Date(Math.floor(now / DAY) * DAY - BUG_DAYS * DAY).toISOString().slice(0, 10);
    for (const d of await readdir(this.root).catch(() => [] as string[])) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) await rm(join(this.root, d), { recursive: true, force: true });
  }
}

/** The newest client error records across the retained day files, newest first. */
export async function recentErrors(root: string, limit = 100): Promise<Record<string, unknown>[]> {
  const days = (await readdir(root).catch(() => [] as string[])).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  const out: Record<string, unknown>[] = [];
  for (const day of days) {
    for (const f of await readdir(join(root, day)).catch(() => [] as string[])) {
      const text = await readFile(join(root, day, f), 'utf8').catch(() => '');
      for (const line of text.split('\n')) if (line) try { const r = JSON.parse(line); if (r.type === 'error') out.push(r); } catch { /* skip */ }
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => Number(b.srv) - Number(a.srv)).slice(0, limit);
}
