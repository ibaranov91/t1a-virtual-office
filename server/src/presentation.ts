// Presentation mode: what's on the Meeting room's wall screen, per scope (the office floor, or one meeting instance).
// One presenter per scope; a show is a deck from their library (decks.ts) or their screen as JPEG frames.
// Who's presenting what is in memory only.
//
// TODO (live-state session): screen share (`share`, `frame`: rate limit, size check, relay to the scope minus the presenter),
// `tick`/`gone`/`back` per scope, ending a scope's show when its instance ends, re-sending `presentation` when someone
// changes scope (World.enterMeeting / leaveMeeting / connect), letting `use`/`isBeside` work for the screen inside an instance.
import { roomAt, type TileMap } from '../../shared/map';
import { OFFICE_SCOPE, PRESENT_AWAY_MS, type DeckInfo, type LiveDeck, type ServerMsg } from '../../shared/protocol';
import { DeckStore, PresentError } from './decks';

export { DeckStore, DECK_ID_RE, PresentError } from './decks';

/** What the presenter needs from the world. */
export interface PresentIO {
  /** OFFICE_SCOPE, the instance id, or null when they're offline / underground (can't present from there). */
  scopeOf(userId: string): string | null;
  /** Standing beside the object (or heading to a tile beside it, with `settled` false), in their own scope. */
  beside(userId: string, objectId: string, settled?: boolean): boolean;
  /** Send to everyone in a scope (except one person). */
  toScope(scope: string, msg: ServerMsg, except?: string): void;
  name(userId: string): string;
}

export class Presenter {
  /** scope → what's on that scope's screen */
  lives = new Map<string, LiveDeck>();
  private awayTimers = new Map<string, NodeJS.Timeout>();

  constructor(public store: DeckStore, private map: TileMap, private io: PresentIO) {}

  /** What `userId` should see on their screen right now. */
  liveFor(userId: string): LiveDeck | null { const s = this.io.scopeOf(userId); return s ? this.lives.get(s) ?? null : null; }
  /** The show `userId` is presenting, if any. */
  mine(userId: string) { for (const l of this.lives.values()) if (l.presenter === userId) return l; return null; }
  /** Backwards-compatible view: the office floor's show. */
  get live() { return this.lives.get(OFFICE_SCOPE) ?? null; }

  private screen(objectId: unknown) {
    const o = this.map.objects.find(o => o.id === objectId && o.use?.kind === 'presentation');
    const room = o && (roomAt(this.map, o.x, o.y) ?? roomAt(this.map, o.x, o.y + o.h)); // on a wall: the room it faces
    if (!o || !room) throw new PresentError(400, 'No such screen.');
    return { objectId: o.id, room: room.id };
  }
  /** Beside the screen, in a scope, and that scope's screen is free (or mine). */
  private claim(userId: string, objectId: unknown) {
    const at = this.screen(objectId);
    const scope = this.io.scopeOf(userId);
    if (!scope) throw new PresentError(403, 'You can\'t present from there.');
    if (!this.io.beside(userId, at.objectId)) throw new PresentError(403, 'Walk up to the board first.');
    const busy = this.lives.get(scope);
    if (busy && busy.presenter !== userId) throw new PresentError(409, `${this.io.name(busy.presenter)} is presenting. Wait for them to finish.`, { presenter: busy.presenter });
    return { ...at, scope };
  }

  /** Upload a deck to my library and show it. */
  async upload(userId: string, body: { title?: unknown; objectId?: unknown; files?: unknown }) {
    const at = this.claim(userId, body.objectId);
    const deck = await this.store.save(userId, body.title, body.files);
    this.start(userId, deck, at);
    return deck;
  }
  /** Show a deck from my library. */
  present(userId: string, body: { deck?: unknown; objectId?: unknown }) {
    const at = this.claim(userId, body.objectId);
    const deck = this.store.get(body.deck);
    if (!deck || deck.by !== userId) throw new PresentError(404, 'That deck is gone.');
    this.start(userId, deck, at);
    return deck;
  }
  /** Delete one of my decks (and take it down if it's up). */
  async remove(userId: string, id: unknown) {
    const deck = await this.store.delete(userId, id);
    for (const l of this.lives.values()) if (l.deck?.id === deck.id) this.stop(l.presenter);
  }

  private start(presenter: string, deck: DeckInfo | null, at: { objectId: string; room: string; scope: string }) {
    this.clearAway(at.scope);
    this.lives.set(at.scope, { scope: at.scope, presenter, objectId: at.objectId, room: at.room, deck, slide: 0 });
    this.announce(at.scope);
  }
  private announce(scope: string) { this.io.toScope(scope, { t: 'presentation', live: this.lives.get(scope) ?? null }); }
  private clearAway(scope: string) { clearTimeout(this.awayTimers.get(scope)); this.awayTimers.delete(scope); }

  /** The presenter walked off from the board: the slides come down (a closed tab has its own minute, see `gone`). */
  tick() {
    for (const l of this.lives.values()) if (!l.away && !this.io.beside(l.presenter, l.objectId, false)) this.stop(l.presenter);
  }
  slide(userId: string, n: unknown) {
    const l = this.mine(userId);
    if (!l?.deck || typeof n !== 'number' || !Number.isInteger(n)) return;
    const slide = Math.max(0, Math.min(l.deck.count - 1, n));
    if (slide !== l.slide) { l.slide = slide; this.announce(l.scope); }
  }
  stop(userId: string) {
    const l = this.mine(userId); if (!l) return;
    this.clearAway(l.scope); this.lives.delete(l.scope); this.announce(l.scope);
  }
  /** The presenter's last tab closed: keep the show up a minute in case they're back. */
  gone(userId: string) {
    const l = this.mine(userId); if (!l) return;
    l.away = true; this.announce(l.scope);
    this.clearAway(l.scope);
    this.awayTimers.set(l.scope, setTimeout(() => this.stop(userId), PRESENT_AWAY_MS));
  }
  back(userId: string) {
    const l = this.mine(userId); if (!l?.away) return;
    this.clearAway(l.scope); delete l.away; this.announce(l.scope);
  }
}
