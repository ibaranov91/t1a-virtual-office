import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const DIAG_MAX_BYTES = 256 * 1024;
const DAILY_BYTES = 50 * 1024 * 1024, DAY = 86400_000;
export class DiagError extends Error { constructor(public code: number, message: string) { super(message); } }
interface Batch { page: string; ua: string; records: Record<string, unknown>[] }
export function validateDiag(value: unknown): Batch {
  const b = value as Batch | null;
  if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.page !== 'string' || b.page.length > 40 ||
    typeof b.ua !== 'string' || b.ua.length > 400 || !Array.isArray(b.records) || b.records.length > 2000 ||
    b.records.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new DiagError(400, 'Invalid diagnostics');
  return b;
}
export function diagPath(root: string, userId: string, now: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new DiagError(400, 'Invalid user');
  return join(root, new Date(now).toISOString().slice(0, 10), `${userId}.jsonl`);
}
export class DiagStore {
  private requests = new Map<string, number>();
  private writes = new Map<string, Promise<void>>();
  constructor(private root: string) {}
  begin(session: string, now = Date.now()) {
    const previous = this.requests.get(session);
    if (previous !== undefined && now - previous < 1000) throw new DiagError(429, 'Diagnostics rate limit');
    this.requests.set(session, now);
  }
  async append(userId: string, name: string, batch: Batch, now = Date.now()) {
    const file = diagPath(this.root, userId, now);
    // Serialize per file: concurrent sessions cannot both spend the same remaining quota.
    const write = (this.writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const lines = batch.records.map((record, i) => {
        const { srv: _srv, user: _user, name: _name, page: _page, ua: _ua, ...data } = record;
        return JSON.stringify({ ...data, srv: now, user: userId, name, page: batch.page, ...(i === 0 ? { ua: batch.ua } : {}) });
      }).join('\n') + (batch.records.length ? '\n' : '');
      const used = await stat(file).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
      if (used + Buffer.byteLength(lines) > DAILY_BYTES) throw new DiagError(413, 'Daily diagnostics limit');
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, lines);
    });
    this.writes.set(file, write);
    try { await write; } finally { if (this.writes.get(file) === write) this.writes.delete(file); }
  }
  async sweep(now = Date.now()) {
    for (const [key, at] of this.requests) if (now - at >= 1000) this.requests.delete(key);
    const cutoff = new Date(Math.floor(now / DAY) * DAY - 2 * DAY).toISOString().slice(0, 10);
    const entries = await readdir(this.root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const entry of entries) {
      const date = entry.name;
      if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) &&
        new Date(date).toISOString().slice(0, 10) === date && date < cutoff) await rm(join(this.root, date), { recursive: true, force: true });
    }
  }
}
