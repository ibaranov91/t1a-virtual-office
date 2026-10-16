import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Assets } from '../assets';
import type { Store } from '../net';
import { Icon, IconButton } from '../Icon';
import { Avatar } from '../sidebar/Avatar';
import { TABLE_GAMES, type TableGameId, type TableView } from '../../../shared/table/types';
import { COLOURS, type Card, type Colour } from '../../../shared/table/lastcard';
import type { Domino } from '../../../shared/table/dominoes';
import { Board } from './Board';
import { CARD_COLOURS, CardBack, DominoTile, PIECES, PlayingCard } from './art';
import { cardLabel, clock, draughtsMoves, draughtsTaken, fanStep, material, moveRows, sanMoves } from './model';

type Match = NonNullable<TableView['match']>;
const DUEL = (g: TableGameId) => g === 'chess' || g === 'draughts';
const PLAYERS: Record<TableGameId, string> = { chess: '2 players', draughts: '2 players · Russian rules', dominoes: '2–4 players', lastcard: '2–4 players' };
const INVITE_MS = 30_000;

/** Width and height the stage can give its content; the board and the hand size themselves from it. */
function useFit() {
  const ref = useRef<HTMLDivElement>(null), [box, setBox] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => {
      const wide = window.matchMedia('(min-width: 900px)').matches, css = getComputedStyle(el), top = el.getBoundingClientRect().top;
      const padX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight), padY = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
      setBox({ w: el.clientWidth - padX, h: wide ? el.clientHeight - padY : window.innerHeight - top - padY });
    };
    measure(); const ro = new ResizeObserver(measure); ro.observe(el); window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return { ref, ...box };
}

function Person({ store, assets, id, size }: { store: Store; assets: Assets; id: string; size: number }) {
  const u = store.users.get(id);
  return u ? <Avatar assets={assets} user={u} size={size} dot={false} /> : <span className="sb-avatar" style={{ width: size, height: size }}>{store.name(id)[0]}</span>;
}

/** One-click actions that cost the game ask once more, like chess.com's resign. */
function useConfirm() {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t); }, [armed]);
  return { armed, ask: (what: string, run: () => void) => { if (armed === what) { setArmed(null); run(); } else setArmed(what); } };
}

export function TableOverlay({ store, assets }: { store: Store; assets: Assets }) {
  const v = store.table!, m = v.match, invitation = v.invitation, root = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(store.now()), [picking, setPicking] = useState(false), [hideResult, setHideResult] = useState(false);
  const host = v.host === store.me, owner = store.connected && store.voiceOwner, live = !!m && !m.state.result;
  const player = m?.players.indexOf(store.me) ?? -1, active = player >= 0 && !m?.out.includes(store.me), turn = live && active && m?.state.turn === player;
  const confirm = useConfirm(), fit = useFit();
  useEffect(() => {
    const old = document.activeElement; root.current?.focus();
    const timer = setInterval(() => setNow(store.now()), 250);
    return () => { clearInterval(timer); if (old instanceof HTMLElement && old.isConnected) old.focus(); };
  }, [store]);
  useEffect(() => { setPicking(false); setHideResult(false); }, [m?.id]);
  useEffect(() => { if (invitation) setPicking(false); }, [invitation]);

  const left = (deadline: number | null) => deadline === null ? null : deadline - now;
  const gameName = invitation ? TABLE_GAMES[invitation.game] : m && (live || !picking) ? TABLE_GAMES[m.game] : null;
  const leave = () => live && active ? confirm.ask('leave', () => store.tableLeave()) : store.tableLeave();

  let stage: ReactNode;
  if (invitation) stage = <Invitation store={store} assets={assets} v={v} host={host} owner={owner} now={now} />;
  else if (m && (live || !picking)) stage = <Game store={store} assets={assets} v={v} m={m} fit={fit} now={now} owner={owner} turn={turn} active={active} player={player}
    result={!live && !hideResult ? <Result store={store} m={m} host={host} owner={owner} player={player} sitters={v.sitters}
      onNew={() => setPicking(true)} onClose={() => setHideResult(true)} /> : null} />;
  else if (host) stage = <Lobby store={store} assets={assets} v={v} owner={owner} />;
  else stage = <Waiting store={store} assets={assets} v={v} />;

  return <div ref={root} className="gt" role="dialog" aria-modal="true" aria-label="Game table" tabIndex={-1} onKeyDown={e => {
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const items = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]),input')], first = items[0], last = items.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }}>
    <header className="gt-header">
      <div className="gt-title"><b>Game table</b><small>{gameName ? `${gameName} · ` : ''}{host ? 'You host' : `${store.name(v.host)} hosts`}</small></div>
      {confirm.armed === 'leave' && <span className="gt-warn">Leaving now resigns the game.</span>}
      <button className={confirm.armed === 'leave' ? 'danger' : 'ghost'} disabled={!owner} onClick={leave}>
        <Icon name="logout" />{confirm.armed === 'leave' ? 'Resign and leave' : 'Leave table'}</button>
    </header>
    <div className="gt-body">
      <main ref={fit.ref} className="gt-stage">
        {!store.connected && <p className="gt-banner" role="status">Reconnecting… your turn clock keeps running.</p>}
        {stage}
      </main>
      <aside className="gt-side">
        {m && <Status store={store} m={m} turn={turn} active={active} player={player} left={live ? left(v.turnDeadline) : null} />}
        {m && DUEL(m.game) && <Moves m={m} />}
        {live && active && <section className="gt-section gt-actions">
          {DUEL(m!.game) && (m!.drawOffer && m!.drawOffer !== store.me
            ? <><button disabled={!owner} onClick={() => store.tableDraw(true)}>Accept draw</button><button className="ghost" disabled={!owner} onClick={() => store.tableDraw(false)}>Decline</button></>
            : <button className="quiet" disabled={!owner || !!m!.drawOffer} onClick={() => store.tableDraw(true)}>{m!.drawOffer ? 'Draw offered' : 'Offer draw'}</button>)}
          <button className={confirm.armed === 'resign' ? 'danger' : 'quiet'} disabled={!owner} onClick={() => confirm.ask('resign', () => store.tableResign())}>
            {confirm.armed === 'resign' ? 'Confirm resign' : 'Resign'}</button>
        </section>}
        <Seats store={store} assets={assets} v={v} />
      </aside>
    </div>
  </div>;
}

function Status({ store, m, turn, active, player, left }: { store: Store; m: Match; turn: boolean; active: boolean; player: number; left: number | null }) {
  const r = m.state.result, mover = store.name(m.players[m.state.turn]);
  const title = r ? r.winner === null ? 'Draw' : r.winner === player ? 'You won' : `${store.name(m.players[r.winner])} won`
    : turn ? 'Your move' : active ? `Waiting for ${mover}` : `${mover} to move`;
  const sub = r ? r.reason : m.game === 'chess' && m.state.check ? 'Check' : left === null ? '' : `${clock(left)} left on this move · 2 min a move`;
  return <section className="gt-section gt-status" role="status" aria-live="polite">
    <b className={r && r.winner === player ? 'win' : undefined}>{title}</b>{sub && <small className={!r && m.game === 'chess' && m.state.check ? 'alert' : undefined}>{sub}</small>}
  </section>;
}

function Moves({ m }: { m: Match }) {
  const list = useMemo(() => m.game === 'chess' ? sanMoves(m.state.moves) : m.game === 'draughts' ? draughtsMoves(m.state.moves) : [], [m]);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [list.length]);
  return <section className="gt-section gt-moves-wrap">
    <h2 className="gt-head">Moves</h2>
    {list.length ? <ol ref={ref} className="gt-moves" aria-label="Moves">{moveRows(list).map(([n, a, b]) => <li key={n}>
      <span>{n}.</span><b className={list.length === n * 2 - 1 ? 'now' : undefined}>{a}</b><b className={b && list.length === n * 2 ? 'now' : undefined}>{b ?? ''}</b></li>)}</ol>
      : <p className="gt-empty">{m.game === 'chess' ? 'White moves first.' : 'White moves first. Captures are compulsory.'}</p>}
  </section>;
}

function Seats({ store, assets, v }: { store: Store; assets: Assets; v: TableView }) {
  return <section className="gt-section">
    <h2 className="gt-head">At the table <small>{v.sitters.length}/4</small></h2>
    <ul className="gt-people">{v.sitters.map(id => <li key={id}><Person store={store} assets={assets} id={id} size={32} />
      <span className={id === store.me ? 'me' : undefined}>{store.name(id)}</span>{id === v.host && <small>host</small>}</li>)}</ul>
    <h2 className="gt-head">Watching <small>{v.watchers.length}</small></h2>
    {v.watchers.length ? <ul className="gt-people">{v.watchers.map(id => <li key={id}><Person store={store} assets={assets} id={id} size={32} />
      <span className={id === store.me ? 'me' : undefined}>{store.name(id)}</span></li>)}</ul>
      : <p className="gt-empty">Anyone who walks up once the four seats are taken watches from here.</p>}
  </section>;
}

function Clock({ ms }: { ms: number }) {
  return <span className={`gt-clock${ms < 20_000 ? ' low' : ''}`} role="timer" aria-label={`${clock(ms)} left`}><Icon name="clock" />{clock(ms)}</span>;
}

/** A player's strip above or below the board, as on chess.com. */
function PlayerBar({ store, assets, id, label, swatch, trophies, out, clockMs }: {
  store: Store; assets: Assets; id: string; label: string; swatch?: 'w' | 'b'; trophies?: ReactNode; out: boolean; clockMs: number | null;
}) {
  return <div className={`gt-player${clockMs !== null ? ' turn' : ''}${out ? ' out' : ''}`}>
    <Person store={store} assets={assets} id={id} size={36} />
    <div className="gt-player-text">
      <b>{store.name(id)}{id === store.me && <small> (you)</small>}</b>
      <span>{swatch && <i className={`gt-swatch ${swatch}`} />}{out ? 'Out of the game' : label}{trophies}</span>
    </div>
    {clockMs !== null && <Clock ms={clockMs} />}
  </div>;
}

function Trophies({ taken, lead, side }: { taken: string[]; lead: number; side: 'w' | 'b' }) {
  if (!taken.length && lead <= 0) return null;
  const order = ['p', 'n', 'b', 'r', 'q'];
  return <span className="gt-trophies" aria-label={`Captured ${taken.length}`}>
    {order.map(t => taken.filter(x => x === t).map((x, i) => <img key={`${t}${i}`} src={PIECES[`${side}${x}`]} alt="" />))}
    {lead > 0 && <small>+{lead}</small>}
  </span>;
}

function Game({ store, assets, v, m, fit, now, owner, turn, active, player, result }: {
  store: Store; assets: Assets; v: TableView; m: Match; fit: { w: number; h: number }; now: number; owner: boolean; turn: boolean; active: boolean; player: number; result: ReactNode;
}) {
  const live = !m.state.result, ms = live && v.turnDeadline !== null ? v.turnDeadline - now : null;
  // Once the game is over, the result card says who resigned or left; the bars stay plain.
  const clockFor = (i: number) => ms !== null && m.state.turn === i ? ms : null, out = (i: number) => live && m.out.includes(m.players[i]);
  if (m.game === 'chess' || m.game === 'draughts') {
    const flipped = player === 1, bottom = flipped ? 1 : 0, top = 1 - bottom;
    const size = Math.max(256, Math.min(960, Math.floor(Math.min(fit.w, fit.h - 2 * 52) / 8) * 8));
    const taken = m.game === 'chess' ? material(m.state.fen) : null, men = m.game === 'draughts' ? draughtsTaken(m.state.board) : null;
    const trophies = (i: number) => taken ? <Trophies taken={i === 0 ? taken.byWhite : taken.byBlack} lead={i === 0 ? taken.lead : -taken.lead} side={i === 0 ? 'b' : 'w'} />
      : men && (i === 0 ? men.byWhite : men.byBlack) > 0 ? <span className="gt-trophies"><img src={PIECES[i === 0 ? 'bman' : 'wman']} alt="" /><small>×{i === 0 ? men.byWhite : men.byBlack}</small></span> : null;
    const bar = (i: number) => <PlayerBar store={store} assets={assets} id={m.players[i]} label={i === 0 ? 'White' : 'Black'} swatch={i === 0 ? 'w' : 'b'}
      trophies={trophies(i)} out={out(i)} clockMs={clockFor(i)} />;
    const offer = live && active && m.drawOffer && m.drawOffer !== store.me;
    return <div className="gt-duel" style={{ width: size }}>
      {bar(top)}
      <div className="gt-board-wrap">
        <Board key={m.id} view={m.game === 'chess' ? { game: 'chess', state: m.state } : { game: 'draughts', state: m.state }} flipped={flipped} size={size} disabled={!owner || !turn} move={x => store.tableMove(x)} />
        {offer && <div className="gt-float" role="alert"><span>{store.name(m.drawOffer!)} offers a draw</span>
          <button disabled={!owner} onClick={() => store.tableDraw(true)}>Accept</button><button className="ghost" disabled={!owner} onClick={() => store.tableDraw(false)}>Decline</button></div>}
        {result}
      </div>
      {bar(bottom)}
    </div>;
  }
  return <CardTable store={store} assets={assets} v={v} m={m} fit={fit} owner={owner} turn={turn} active={active} player={player} clockFor={clockFor} out={out} result={result} />;
}

function CardTable({ store, assets, v, m, fit, owner, turn, active, player, clockFor, out, result }: {
  store: Store; assets: Assets; v: TableView; m: Match; fit: { w: number; h: number }; owner: boolean; turn: boolean; active: boolean; player: number;
  clockFor(i: number): number | null; out(i: number): boolean; result: ReactNode;
}) {
  const [selected, setSelected] = useState<number | null>(null), [wild, setWild] = useState<Card | null>(null), [lastCard, setLastCard] = useState(false);
  useEffect(() => { setSelected(null); setWild(null); setLastCard(false); }, [v.revision]);
  const dominoes = m.game === 'dominoes' ? m.state : null, cards = m.game === 'lastcard' ? m.state : null;
  const state = (dominoes ?? cards)!, live = !state.result, can = owner && turn;
  const noun = (n: number) => dominoes ? `${n} tile${n === 1 ? '' : 's'}` : `${n} card${n === 1 ? '' : 's'}`;
  const seats = m.players.map((_, i) => i), others = player >= 0 ? [...seats.slice(player + 1), ...seats.slice(0, player)] : seats;
  const phone = fit.w < 560, cardW = phone ? 58 : 84, tileW = phone ? 40 : 56;
  const move = (x: unknown) => store.tableMove(x);

  const hand = dominoes?.hand ?? cards?.hand, handW = dominoes ? tileW : cardW, step = hand ? fanStep(hand.length, handW, Math.min(fit.w, 900)) : 0;
  let felt: ReactNode, handView: ReactNode = null, hint = '', actions: ReactNode = null;
  if (dominoes) {
    const legal = dominoes.legal ?? [], ends = (id: number) => legal.filter(x => x.tile === id).map(x => x.end);
    const pickTile = (t: Domino) => { const e = ends(t.id); if (!can || !e.length) return; if (e.length === 1) move({ kind: 'play', tile: t.id, end: e[0] }); else setSelected(selected === t.id ? null : t.id); };
    const slot = (end: 'left' | 'right') => selected !== null && ends(selected).includes(end) && <button className="gt-slot" disabled={!can} aria-label={`Play on the ${end} end`}
      onClick={() => move({ kind: 'play', tile: selected, end })}><Icon name={end === 'left' ? 'arrow-left' : 'arrow-right'} /></button>;
    const chain = dominoes.chain;
    felt = <div className="gt-felt">
      <div className="gt-chain" role="img" aria-label={chain.length ? `Chain: ${chain.map(t => `${t.a}-${t.b}`).join(', ')}` : 'Empty table'}>
        {slot('left')}{chain.map(t => <span key={t.id} className={t.a === t.b ? 'double' : undefined}><DominoTile tile={t} upright={t.a === t.b} /></span>)}{slot('right')}
        {!chain.length && !slot('right') && <p className="gt-empty">The highest double opens the game.</p>}
      </div>
      <div className="gt-pile"><span className="gt-pile-stack"><DominoTile upright back /></span><small>{dominoes.boneyard} in the boneyard</small></div>
    </div>;
    if (live && active && hand) {
      hint = !turn ? `Waiting for ${store.name(m.players[state.turn])}.` : legal.length ? selected !== null ? 'It fits both ends: pick a side.' : 'Click a lit tile to play it.'
        : dominoes.boneyard ? 'Nothing fits. Draw from the boneyard.' : 'Nothing fits and the boneyard is empty. Pass.';
      actions = turn && !legal.length && <div className="gt-hand-actions">{dominoes.boneyard
        ? <button disabled={!can} onClick={() => move({ kind: 'draw' })}>Draw a tile</button>
        : <button disabled={!can} onClick={() => move({ kind: 'pass' })}>Pass</button>}</div>;
    }
    handView = hand && <div className="gt-hand" role="group" aria-label="Your dominoes" style={{ '--step': `${step}px`, '--w': `${tileW}px` } as React.CSSProperties}>
      {(hand as Domino[]).map(t => { const ok = can && ends(t.id).length > 0;
        return <button key={t.id} className={`gt-tile${ok ? ' playable' : ''}${turn && !ok ? ' dim' : ''}`} aria-label={`${t.a}-${t.b}${ok ? ', playable' : ''}`}
          aria-pressed={selected === t.id} aria-disabled={!ok || undefined} onClick={() => pickTile(t)}><DominoTile tile={t} upright /></button>; })}
    </div>;
  } else {
    const c = cards!, playable = new Set(c.playable ?? []), hold = (hand as Card[] | undefined) ?? [];
    const play = (card: Card, colour?: Colour) => { if (!can || !playable.has(card.id)) return; if (!card.colour && !colour) { setWild(card); return; } move({ kind: 'play', card: card.id, colour, lastCard }); };
    const catchable = c.catchable !== null && live && active && c.catchable !== player;
    felt = <div className="gt-felt">
      <button className={`gt-pile gt-draw${can && c.drawn === null && !playable.size ? ' nudge' : ''}`} disabled={!can || c.drawn !== null} aria-label={`Draw a card, ${c.pile} left`}
        onClick={() => move({ kind: 'draw' })}><span className="gt-pile-stack"><CardBack /></span><small>{can && c.drawn === null ? `Draw · ${c.pile} left` : `${c.pile} to draw`}</small></button>
      <div className="gt-discard" style={{ '--ring': CARD_COLOURS[c.colour] } as React.CSSProperties}>
        <PlayingCard card={c.top} />
        <small><i className="gt-swatch" style={{ background: CARD_COLOURS[c.colour] }} />{c.colour[0].toUpperCase() + c.colour.slice(1)}
          <span className={`gt-dir${c.direction === 1 ? '' : ' ccw'}`} aria-label={c.direction === 1 ? 'clockwise' : 'counterclockwise'}><Icon name="rotate" /></span></small>
      </div>
      {catchable && <button className="gt-catch" disabled={!owner} onClick={() => move({ kind: 'catch' })}>Catch {store.name(m.players[c.catchable!])}: +2 cards</button>}
    </div>;
    if (live && active && hand) {
      hint = !turn ? `Waiting for ${store.name(m.players[state.turn])}.` : c.drawn !== null ? 'You drew a card you can play. Play it or keep it.'
        : playable.size ? 'Play a lit card, or draw.' : 'Nothing to play. Draw a card.';
      actions = turn && (c.drawn !== null || hold.length === 2) && <div className="gt-hand-actions">
        {hold.length === 2 && c.drawn === null && <button className={lastCard ? 'called' : 'quiet'} aria-pressed={lastCard} disabled={!can} onClick={() => setLastCard(!lastCard)}>
          {lastCard ? 'Last card called' : 'Call last card'}</button>}
        {c.drawn !== null && <button className="quiet" disabled={!can} onClick={() => move({ kind: 'pass' })}>Keep it</button>}
        {hold.length === 2 && c.drawn === null && <small>Call it before you play your second-to-last card, or anyone can catch you for +2.</small>}
      </div>;
    }
    handView = hand && <div className="gt-hand cards" role="group" aria-label="Your cards" style={{ '--step': `${step}px`, '--w': `${cardW}px` } as React.CSSProperties}>
      {hold.map(card => { const ok = can && playable.has(card.id);
        return <button key={card.id} className={`gt-cardbtn${ok ? ' playable' : ''}${turn && !ok ? ' dim' : ''}`} aria-label={`${cardLabel(card)}${ok ? ', playable' : ''}`}
          aria-disabled={!ok || undefined} onClick={() => play(card)}><PlayingCard card={card} /></button>; })}
      {wild && <div className="gt-colours" role="group" aria-label="Pick a colour">{COLOURS.map(colour => <button key={colour} aria-label={colour}
        style={{ background: CARD_COLOURS[colour] }} onClick={() => play(wild, colour)} />)}<IconButton icon="close" label="Cancel" className="ghost" onClick={() => setWild(null)} /></div>}
    </div>;
  }
  const chip = (i: number) => <div key={i} className={`gt-seat${clockFor(i) !== null ? ' turn' : ''}${out(i) ? ' out' : ''}`}>
    <Person store={store} assets={assets} id={m.players[i]} size={32} />
    <div><b>{store.name(m.players[i])}</b><small>{out(i) ? 'Out of the game' : noun(state.counts[i])}</small></div>
    {clockFor(i) !== null && <Clock ms={clockFor(i)!} />}
  </div>;
  return <div className="gt-cards" style={{ '--card-w': `${cardW}px`, '--tile-w': `${tileW}px` } as React.CSSProperties}>
    <div className="gt-seats">{others.map(chip)}</div>
    <div className="gt-board-wrap">{felt}{result}</div>
    {player >= 0 && <>
      {hint && <p className="gt-hint" role="status">{hint}</p>}
      {handView}
      {actions}
      <PlayerBar store={store} assets={assets} id={store.me} label={out(player) ? '' : noun(state.counts[player])} out={out(player)} clockMs={clockFor(player)} />
    </>}
  </div>;
}

function Result({ store, m, host, owner, player, sitters, onNew, onClose }: {
  store: Store; m: Match; host: boolean; owner: boolean; player: number; sitters: string[]; onNew(): void; onClose(): void;
}) {
  const r = m.state.result!, missing = m.players.filter(id => !sitters.includes(id));
  const title = r.winner === null ? 'Draw' : r.winner === player ? 'You won' : `${store.name(m.players[r.winner])} won`;
  return <div className="gt-result" role="status" aria-label={`${title}: ${r.reason}`}>
    <IconButton icon="close" label="See the final position" className="ghost gt-result-close" onClick={onClose} />
    <Icon name="trophy" /><b>{title}</b><small>{r.reason}</small>
    {host ? <div className="gt-result-actions">
      <button disabled={!owner || !!missing.length || !m.players.includes(store.me)} onClick={() => store.tablePick(m.game, undefined, true)}>Rematch</button>
      <button className="quiet" disabled={!owner} onClick={onNew}>New game</button>
      {missing.length > 0 && <small>{missing.map(id => store.name(id)).join(', ')} left the table, so no rematch.</small>}
    </div> : <small>{store.name(sitters[0])} picks the next game.</small>}
  </div>;
}

function GameArt({ game }: { game: TableGameId }) {
  if (game === 'chess' || game === 'draughts') {
    const set = game === 'chess' ? [null, 'bk', null, 'bq', 'wn', null, 'wp', null] : [null, 'bman', null, 'bking', 'wman', null, 'wman', null];
    return <span className="gt-art board" aria-hidden="true">{set.map((p, i) => <i key={i} className={(i % 4 + (i / 4 | 0)) % 2 ? 'dark' : 'light'}>{p && <img src={PIECES[p]} alt="" />}</i>)}</span>;
  }
  if (game === 'dominoes') return <span className="gt-art dominoes" aria-hidden="true"><DominoTile tile={{ id: 0, a: 6, b: 3 }} upright /><DominoTile tile={{ id: 1, a: 5, b: 5 }} upright /></span>;
  return <span className="gt-art cards" aria-hidden="true">{(['red', 'yellow', 'blue'] as Colour[]).map((colour, i) =>
    <PlayingCard key={colour} card={{ id: i, colour, symbol: (['7', 'skip', 'two'] as const)[i] }} />)}</span>;
}

function Lobby({ store, assets, v, owner }: { store: Store; assets: Assets; v: TableView; owner: boolean }) {
  const [game, setGame] = useState<TableGameId>(v.pick ?? 'chess'), [invites, setInvites] = useState<string[]>([]);
  const peers = v.sitters.filter(id => id !== store.me), max = DUEL(game) ? 1 : 3;
  useEffect(() => { setInvites(list => list.filter(id => v.sitters.includes(id)).slice(0, max)); }, [max, v.sitters]);
  const toggle = (id: string) => setInvites(max === 1 ? invites.includes(id) ? [] : [id] : invites.includes(id) ? invites.filter(x => x !== id) : invites.length < max ? [...invites, id] : invites);
  return <section className="gt-panel gt-lobby" aria-label="Pick a game">
    <h2>Pick a game</h2>
    <div className="gt-games" role="radiogroup" aria-label="Game">{(Object.keys(TABLE_GAMES) as TableGameId[]).map(id =>
      <button key={id} role="radio" aria-checked={game === id} className={`gt-game${game === id ? ' on' : ''}`} disabled={!owner} onClick={() => setGame(id)}>
        <GameArt game={id} /><b>{TABLE_GAMES[id]}</b><small>{PLAYERS[id]}</small></button>)}</div>
    <h3 className="gt-head">Players <small>{max === 1 ? 'pick one opponent' : 'pick up to three'}</small></h3>
    <div className="gt-pick">
      <div className="gt-pick-row self"><Person store={store} assets={assets} id={store.me} size={32} /><b>{store.name(store.me)} <small>(you)</small></b><span className="gt-check"><Icon name="check" /></span></div>
      {peers.map(id => { const on = invites.includes(id);
        return <button key={id} role="checkbox" aria-checked={on} className={`gt-pick-row${on ? ' on' : ''}`} disabled={!owner} onClick={() => toggle(id)}>
          <Person store={store} assets={assets} id={id} size={32} /><b>{store.name(id)}</b><span className="gt-check">{on && <Icon name="check" />}</span></button>; })}
      {!peers.length && <p className="gt-empty">Nobody else is sitting here yet. Anyone who clicks the game table takes a free seat: four seats, everyone after that watches.</p>}
    </div>
    <div className="gt-foot"><button className="big" disabled={!owner || !invites.length} onClick={() => store.tablePick(game, invites)}>Invite to {TABLE_GAMES[game]}</button>
      <small>{invites.length ? 'They get 30 seconds to join.' : peers.length ? 'Pick who plays.' : 'Waiting for someone to sit down.'}</small></div>
  </section>;
}

function Invitation({ store, assets, v, host, owner, now }: { store: Store; assets: Assets; v: TableView; host: boolean; owner: boolean; now: number }) {
  const inv = v.invitation!, ms = Math.max(0, inv.until - now), mine = inv.invited.includes(store.me), joined = inv.accepted.includes(store.me);
  const enough = inv.accepted.length >= 2 && !(inv.rematch && inv.invited.some(id => !inv.accepted.includes(id)));
  return <section className="gt-panel gt-invite" aria-label="Invitation">
    <GameArt game={inv.game} />
    <h2>{inv.rematch ? `${TABLE_GAMES[inv.game]} rematch` : TABLE_GAMES[inv.game]}</h2>
    <p>{host ? 'Waiting for players to join.' : mine ? `${store.name(v.host)} invites you to play.` : `${store.name(v.host)} is starting a game.`}</p>
    <ul className="gt-people big">{[v.host, ...inv.invited].map(id => { const ready = inv.accepted.includes(id);
      return <li key={id}><Person store={store} assets={assets} id={id} size={32} /><span className={id === store.me ? 'me' : undefined}>{store.name(id)}</span>
        <small className={ready && id !== v.host ? 'ready' : undefined}>{id === v.host ? 'Host' : ready ? 'Ready' : 'Invited'}</small></li>; })}</ul>
    <div className="gt-timer" role="timer" aria-label={`${Math.ceil(ms / 1000)} seconds left to join`}><i style={{ width: `${ms / INVITE_MS * 100}%` }} /></div>
    <small className="gt-timer-text">{Math.ceil(ms / 1000)}s left to join</small>
    <div className="gt-foot">
      {host ? <button className="big" disabled={!owner || !enough} onClick={() => store.tableStart()}>Start {TABLE_GAMES[inv.game]}</button>
        : mine ? <button className="big" disabled={!owner || joined} onClick={() => store.tableStart()}>{joined ? 'Joined' : 'Join game'}</button> : null}
      {host && !enough && <small>{DUEL(inv.game) || inv.rematch ? 'Starts once everyone has joined.' : 'Starts once at least one player has joined.'}</small>}
      {!host && joined && <small>Waiting for {store.name(v.host)} to start.</small>}
    </div>
  </section>;
}

function Waiting({ store, assets, v }: { store: Store; assets: Assets; v: TableView }) {
  const seated = v.sitters.includes(store.me);
  return <section className="gt-panel gt-waiting" aria-label="Waiting">
    <h2>{seated ? `Waiting for ${store.name(v.host)}` : 'All four seats are taken'}</h2>
    <p>{seated ? `${store.name(v.host)} picks the game and who plays.` : 'You are watching. The next game shows up here.'}</p>
    <div className="gt-chairs">{[0, 1, 2, 3].map(i => { const id = v.sitters[i];
      return <div key={i} className={`gt-chair${id ? '' : ' empty'}`}>{id ? <><Person store={store} assets={assets} id={id} size={40} /><b>{store.name(id)}</b>
        <small>{id === v.host ? 'Host' : id === store.me ? 'You' : 'Seated'}</small></> : <><span className="gt-chair-dot" /><small>Free seat</small></>}</div>; })}</div>
  </section>;
}

