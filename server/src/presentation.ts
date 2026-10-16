// Presentation mode: slide decks uploaded with a PIN, shown on a screen object to everyone in its room.
// Decks are files under data/decks/<id>/ (they survive restarts); who's presenting what is in memory only.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { roomAt, type TileMap } from '../../shared/map';
import { PRESENT_AWAY_MS, PRESENT_MAX_SLIDES, type DeckInfo, type LiveDeck, type ServerMsg } from '../../shared/protocol';

const PIN = process.env.DECK_PRESENT_PIN ?? '1234';
const PIN_TRIES = 5; // wrong PINs per person per minute
export const DECK_ID_RE = /^[0-9a-f-]{36}$/;

export class PresentError extends Error { constructor(public code: number, msg: string) { super(msg); } }

const kindOf = (b: Buffer) => b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG' ? 'png'
  : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg'
  : b.subarray(0, 5).toString() === '%PDF-' ? 'pdf' : null;

/** PDF pages → PNGs with poppler's pdftoppm, if this machine has it. */
async function pdfPages(pdf: Buffer): Promise<Buffer[]> {
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

export class Presenter {
  live: LiveDeck | null = null;
  decks = new Map<string, DeckInfo>();
  private awayTimer: NodeJS.Timeout | undefined;
  private wrong = new Map<string, number[]>();

  constructor(private dir: string, private map: TileMap, private broadcast: (msg: ServerMsg) => void,
    private beside: (userId: string, objectId: string, settled?: boolean) => boolean = () => true) {
    if (!existsSync(dir)) return;
    for (const id of readdirSync(dir)) {
      try { if (DECK_ID_RE.test(id)) this.decks.set(id, JSON.parse(readFileSync(join(dir, id, 'deck.json'), 'utf8'))); }
      catch { /* half-written deck: skip it */ }
    }
  }

  checkPin(userId: string, pin: unknown) {
    const now = Date.now(), tries = (this.wrong.get(userId) ?? []).filter(t => now - t < 60_000);
    if (tries.length >= PIN_TRIES) throw new PresentError(429, 'Too many wrong PINs. Wait a minute.');
    const a = Buffer.from(String(pin ?? '')), b = Buffer.from(PIN);
    if (a.length === b.length && timingSafeEqual(a, b)) return;
    this.wrong.set(userId, [...tries, now]);
    throw new PresentError(403, 'Wrong PIN.');
  }

  private screen(objectId: unknown) {
    const o = this.map.objects.find(o => o.id === objectId && o.use?.kind === 'presentation');
    const room = o && (roomAt(this.map, o.x, o.y) ?? roomAt(this.map, o.x, o.y + o.h)); // on a wall: the room it faces
    if (!o || !room) throw new PresentError(400, 'No such screen.');
    return { objectId: o.id, room: room.id };
  }

  /** files: base64 PNG/JPG images (one per slide, in order) or a single PDF. */
  async upload(userId: string, body: { pin?: unknown; title?: unknown; objectId?: unknown; files?: unknown }) {
    const at = this.screen(body.objectId);
    this.mustBeAt(userId, at.objectId);
    this.checkPin(userId, body.pin);
    if (!Array.isArray(body.files) || !body.files.length) throw new PresentError(400, 'Pick some slides.');
    let slides: Buffer[] = body.files.map(f => Buffer.from(String(f ?? ''), 'base64'));
    if (slides.length === 1 && kindOf(slides[0]) === 'pdf') slides = await pdfPages(slides[0]);
    if (!slides.length) throw new PresentError(400, 'That PDF has no pages.');
    if (slides.length > PRESENT_MAX_SLIDES) throw new PresentError(413, `At most ${PRESENT_MAX_SLIDES} slides.`);
    const ext = slides.map(kindOf);
    if (ext.some(k => k !== 'png' && k !== 'jpg')) throw new PresentError(415, 'Slides must be PNG or JPG images, or one PDF.');
    const id = randomUUID(), folder = join(this.dir, id);
    const deck: DeckInfo = { id, title: String(body.title ?? '').trim().slice(0, 60) || 'Untitled', count: slides.length, ext: ext as string[], by: userId, at: Date.now() };
    await mkdir(folder, { recursive: true });
    await Promise.all(slides.map((s, i) => writeFile(join(folder, `${i + 1}.${ext[i]}`), s)));
    await writeFile(join(folder, 'deck.json'), JSON.stringify(deck));
    this.decks.set(id, deck);
    this.start(userId, deck, at);
    return deck;
  }

  /** Show a deck uploaded earlier. */
  present(userId: string, body: { pin?: unknown; deck?: unknown; objectId?: unknown }) {
    const at = this.screen(body.objectId);
    this.mustBeAt(userId, at.objectId);
    this.checkPin(userId, body.pin);
    const deck = this.decks.get(String(body.deck));
    if (!deck) throw new PresentError(404, 'That deck is gone.');
    this.start(userId, deck, at);
    return deck;
  }

  private mustBeAt(userId: string, objectId: string) {
    if (!this.beside(userId, objectId)) throw new PresentError(403, 'Walk up to the board first.');
  }
  /** The presenter walked off from the board: the slides come down (a closed tab has its own minute, see `gone`). */
  tick() {
    const l = this.live;
    if (l && !l.away && !this.beside(l.presenter, l.objectId, false)) this.stop(l.presenter);
  }

  /** Whoever has the PIN may take the screen over. */
  private start(presenter: string, deck: DeckInfo, at: { objectId: string; room: string }) {
    this.mustBeAt(presenter, at.objectId);
    clearTimeout(this.awayTimer);
    this.live = { deck, slide: 0, presenter, ...at };
    this.announce();
  }
  private announce() { this.broadcast({ t: 'presentation', live: this.live }); }

  slide(userId: string, n: unknown) {
    const l = this.live;
    if (!l || l.presenter !== userId || typeof n !== 'number' || !Number.isInteger(n)) return;
    const slide = Math.max(0, Math.min(l.deck.count - 1, n));
    if (slide !== l.slide) { l.slide = slide; this.announce(); }
  }
  stop(userId: string) {
    if (this.live?.presenter !== userId) return;
    clearTimeout(this.awayTimer); this.live = null; this.announce();
  }
  /** The presenter's last tab closed: keep the slides up a minute in case they're back. */
  gone(userId: string) {
    if (this.live?.presenter !== userId) return;
    this.live.away = true; this.announce();
    clearTimeout(this.awayTimer);
    this.awayTimer = setTimeout(() => this.stop(userId), PRESENT_AWAY_MS);
  }
  back(userId: string) {
    if (this.live?.presenter !== userId || !this.live.away) return;
    clearTimeout(this.awayTimer); delete this.live.away; this.announce();
  }
}
