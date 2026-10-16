// Deck library: slide decks people uploaded, as files under data/decks/. One library per person, with a quota and a TTL.
// Who's *showing* a deck is presentation.ts's business; this file only stores, lists, serves and sweeps.
//
// TODO (storage session): per-user folders data/decks/<userKey>/<deckId>/ with a one-time migration of the old flat
// data/decks/<deckId>/ layout (by `deck.by`), quota (PRESENT_USER_QUOTA / env PRESENT_USER_QUOTA_MB), hourly sweep
// (PRESENT_TTL_MS / env PRESENT_TTL_HOURS), `delete`, `bytes` and `key` on every deck (old deck.json files lack them).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { PRESENT_MAX_SLIDES, PRESENT_TTL_MS, PRESENT_USER_QUOTA, type DeckInfo } from '../../shared/protocol';

export const DECK_ID_RE = /^[0-9a-f-]{36}$/;
export const USER_QUOTA = process.env.PRESENT_USER_QUOTA_MB ? Number(process.env.PRESENT_USER_QUOTA_MB) * 1024 * 1024 : PRESENT_USER_QUOTA;
export const DECK_TTL_MS = process.env.PRESENT_TTL_HOURS ? Number(process.env.PRESENT_TTL_HOURS) * 3600_000 : PRESENT_TTL_MS;

export class PresentError extends Error { constructor(public code: number, msg: string, public extra: Record<string, unknown> = {}) { super(msg); } }

export const kindOf = (b: Buffer) => b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG' ? 'png'
  : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg'
  : b.subarray(0, 5).toString() === '%PDF-' ? 'pdf' : null;

/** PDF pages → PNGs with poppler's pdftoppm, if this machine has it (old clients only: new ones render PDFs themselves). */
export async function pdfPages(pdf: Buffer): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'deck-pdf-'));
  try {
    await writeFile(join(dir, 'in.pdf'), pdf);
    await new Promise<void>((ok, fail) => execFile('pdftoppm', ['-png', '-scale-to', '1280', '-l', String(PRESENT_MAX_SLIDES), 'in.pdf', 'p'],
      { cwd: dir, timeout: 60_000 }, e => (e ? fail(e) : ok())));
    const pages = (await readdir(dir)).filter(f => /^p-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
    return Promise.all(pages.map(f => readFile(join(dir, f))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new PresentError(415, 'This server can\'t read PDFs (no pdftoppm). Export the slides as PNG or JPG images instead.');
    throw new PresentError(400, 'Couldn\'t read that PDF.');
  } finally { void rm(dir, { recursive: true, force: true }); }
}

export class DeckStore {
  decks = new Map<string, DeckInfo>();

  constructor(private dir: string) {
    if (!existsSync(dir)) return;
    for (const id of readdirSync(dir)) {
      try {
        if (!DECK_ID_RE.test(id)) continue;
        const d = JSON.parse(readFileSync(join(dir, id, 'deck.json'), 'utf8')) as DeckInfo;
        this.decks.set(id, { ...d, bytes: d.bytes ?? 0, key: d.key ?? DeckStore.newKey() });
      } catch { /* half-written deck: skip it */ }
    }
  }
  static newKey() { return randomBytes(12).toString('base64url'); }

  /** Everything `userKey` uploaded, newest first. */
  list(userKey: string) { return [...this.decks.values()].filter(d => d.by === userKey).sort((a, b) => b.at - a.at); }
  used(userKey: string) { return this.list(userKey).reduce((n, d) => n + d.bytes, 0); }
  get(id: unknown) { return typeof id === 'string' && DECK_ID_RE.test(id) ? this.decks.get(id) : undefined; }
  /** Where slide `n` (1-based) of a deck lives on disk. */
  slidePath(deck: DeckInfo, n: number) { return join(this.dir, deck.id, `${n}.${deck.ext[n - 1]}`); }

  /** Validate and write a deck. `files`: base64 PNG/JPG images (one per slide, in order) or a single PDF. */
  async save(userKey: string, title: unknown, files: unknown): Promise<DeckInfo> {
    if (!Array.isArray(files) || !files.length) throw new PresentError(400, 'Pick some slides.');
    let slides: Buffer[] = files.map(f => Buffer.from(String(f ?? ''), 'base64'));
    if (slides.length === 1 && kindOf(slides[0]) === 'pdf') slides = await pdfPages(slides[0]);
    if (!slides.length) throw new PresentError(400, 'That PDF has no pages.');
    if (slides.length > PRESENT_MAX_SLIDES) throw new PresentError(413, `At most ${PRESENT_MAX_SLIDES} slides.`);
    const ext = slides.map(kindOf);
    if (ext.some(k => k !== 'png' && k !== 'jpg')) throw new PresentError(415, 'Slides must be PNG or JPG images, or one PDF.');
    const bytes = slides.reduce((n, s) => n + s.length, 0);
    if (this.used(userKey) + bytes > USER_QUOTA) throw new PresentError(413, `Your library is full (${Math.round(USER_QUOTA / 1024 / 1024)} MB). Delete a deck first.`);
    const id = randomUUID(), folder = join(this.dir, id);
    const deck: DeckInfo = { id, title: String(title ?? '').trim().slice(0, 60) || 'Untitled', count: slides.length, ext: ext as string[], by: userKey, at: Date.now(), bytes, key: DeckStore.newKey() };
    await mkdir(folder, { recursive: true });
    await Promise.all(slides.map((s, i) => writeFile(join(folder, `${i + 1}.${ext[i]}`), s)));
    await writeFile(join(folder, 'deck.json'), JSON.stringify(deck));
    this.decks.set(id, deck);
    return deck;
  }

  /** Remove one of `userKey`'s decks. */
  async delete(userKey: string, id: unknown) {
    const deck = this.get(id);
    if (!deck || deck.by !== userKey) throw new PresentError(404, 'That deck is gone.');
    this.decks.delete(deck.id);
    await rm(join(this.dir, deck.id), { recursive: true, force: true });
    return deck;
  }

  /** Decks older than the TTL go. Returns what went, so live shows of them can be stopped. */
  async sweep(now = Date.now()) {
    const gone = [...this.decks.values()].filter(d => now - d.at > DECK_TTL_MS);
    for (const d of gone) { this.decks.delete(d.id); await rm(join(this.dir, d.id), { recursive: true, force: true }); }
    return gone;
  }
}
