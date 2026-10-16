// Deck library: slide decks people uploaded, as files under data/decks/. One library per person, with a quota and a TTL.
// Who's *showing* a deck is presentation.ts's business; this file only stores, lists, serves and sweeps.
//
// Layout: data/decks/<userKey>/<deckId>/{deck.json,1.png,...}. The old flat data/decks/<deckId>/ layout is moved on startup.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { PRESENT_MAX_SLIDES, PRESENT_TTL_MS, PRESENT_USER_QUOTA, type DeckInfo } from '../../shared/protocol';

export const DECK_ID_RE = /^[0-9a-f-]{36}$/;
const positive = (v: number, dflt: number) => Number.isFinite(v) && v > 0 ? v : dflt;
export const USER_QUOTA = positive(Number(process.env.PRESENT_USER_QUOTA_MB) * 1024 * 1024, PRESENT_USER_QUOTA);
export const DECK_TTL_MS = positive(Number(process.env.PRESENT_TTL_HOURS) * 3600_000, PRESENT_TTL_MS);
/** A user id as a folder name that can't leave the decks dir. */
export const userDirName = (userKey: string) => {
  const n = encodeURIComponent(userKey).replace(/^\./, '%2E');
  if (!userKey || n.length > 200) throw new PresentError(400, 'Bad user.');
  return n;
};
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

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

  constructor(private dir: string, private quota = USER_QUOTA, private ttl = DECK_TTL_MS) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      try {
        const folder = join(dir, name);
        if (!statSync(folder).isDirectory()) continue;
        if (existsSync(join(folder, 'deck.json'))) this.load(folder, name, true); // old flat layout
        else for (const id of readdirSync(folder)) this.load(join(folder, id), id, false, name);
      } catch { /* unreadable folder: skip it */ }
    }
  }
  /** Read one deck folder, fill in missing fields, and (for the old flat layout) move it under its owner. */
  private load(folder: string, id: string, flat: boolean, userDir?: string) {
    try {
      if (!DECK_ID_RE.test(id)) return;
      const file = join(folder, 'deck.json'), d = JSON.parse(readFileSync(file, 'utf8')) as DeckInfo;
      if (d.id !== id || typeof d.by !== 'string' || !Array.isArray(d.ext) || !Number.isInteger(d.count)) return;
      const home = userDirName(d.by);
      if (!flat && home !== userDir) return;
      let dirty = false;
      if (typeof d.bytes !== 'number') { d.bytes = d.ext.reduce((n, e, i) => n + statSync(join(folder, `${i + 1}.${e}`)).size, 0); dirty = true; }
      if (typeof d.key !== 'string' || !d.key) { d.key = DeckStore.newKey(); dirty = true; }
      if (dirty) writeFileSync(file, JSON.stringify(d));
      if (flat) {
        const dest = join(this.dir, home, id);
        mkdirSync(join(this.dir, home), { recursive: true });
        renameSync(folder, dest);
      }
      this.decks.set(id, d);
    } catch { /* half-written deck: skip it */ }
  }
  static newKey() { return randomBytes(12).toString('base64url'); }

  private folder(deck: { by: string; id: string }) { return join(this.dir, userDirName(deck.by), deck.id); }
  /** Remove a deck's files, and its owner's folder once it's empty. */
  private async wipe(deck: DeckInfo) {
    await rm(this.folder(deck), { recursive: true, force: true });
    await rmdir(join(this.dir, userDirName(deck.by))).catch(() => {}); // not empty: other decks remain
  }

  /** Everything `userKey` uploaded, newest first. */
  list(userKey: string) { return [...this.decks.values()].filter(d => d.by === userKey).sort((a, b) => b.at - a.at); }
  used(userKey: string) { return this.list(userKey).reduce((n, d) => n + d.bytes, 0); }
  get(id: unknown) { return typeof id === 'string' && DECK_ID_RE.test(id) ? this.decks.get(id) : undefined; }
  /** Where slide `n` (1-based) of a deck lives on disk. */
  slidePath(deck: DeckInfo, n: number) { return join(this.folder(deck), `${n}.${deck.ext[n - 1]}`); }

  /** Validate and write a deck. `files`: base64 PNG/JPG images (one per slide, in order) or a single PDF. */
  async save(userKey: string, title: unknown, files: unknown): Promise<DeckInfo> {
    if (!Array.isArray(files) || !files.length) throw new PresentError(400, 'Pick some slides.');
    userDirName(userKey);
    let slides: Buffer[] = files.map(f => Buffer.from(String(f ?? ''), 'base64'));
    if (slides.length === 1 && kindOf(slides[0]) === 'pdf') slides = await pdfPages(slides[0]);
    if (!slides.length) throw new PresentError(400, 'That PDF has no pages.');
    if (slides.length > PRESENT_MAX_SLIDES) throw new PresentError(413, `At most ${PRESENT_MAX_SLIDES} slides.`);
    const ext = slides.map(kindOf);
    if (ext.some(k => k !== 'png' && k !== 'jpg')) throw new PresentError(415, 'Slides must be PNG or JPG images, or one PDF.');
    const bytes = slides.reduce((n, s) => n + s.length, 0);
    const free = Math.max(0, this.quota - this.used(userKey));
    if (bytes > free) throw new PresentError(413, `Not enough room in your library: ${mb(bytes)} MB needed, ${mb(free)} MB free of ${mb(this.quota)} MB. Delete a deck first.`);
    const id = randomUUID();
    const deck: DeckInfo = { id, title: String(title ?? '').trim().slice(0, 60) || 'Untitled', count: slides.length, ext: ext as string[], by: userKey, at: Date.now(), bytes, key: DeckStore.newKey() };
    const folder = this.folder(deck);
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
    await this.wipe(deck);
    return deck;
  }

  /** Decks older than the TTL go. Returns what went, so live shows of them can be stopped. */
  async sweep(now = Date.now()) {
    const gone = [...this.decks.values()].filter(d => now - d.at > this.ttl);
    for (const d of gone) { this.decks.delete(d.id); await this.wipe(d); }
    return gone;
  }
}
