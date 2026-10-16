import { useEffect, useRef, useState } from 'react';
import type { Assets } from '../assets';
import type { Store } from '../net';
import { TABLE_GAMES, type TableGameId, type GameView } from '../../../shared/table/types';
import { COLOURS, type Card, type Colour } from '../../../shared/table/lastcard';
import type { Domino } from '../../../shared/table/dominoes';
import { board, card, domino, cardLabel, squareName, squareIndex, CARD_COLOURS } from './render';
function TileCanvas({ value }: { value: Card | Domino }) {
  const ref = useRef<HTMLCanvasElement>(null), isCard = 'symbol' in value;
  useEffect(() => { const c = ref.current!.getContext('2d')!; c.clearRect(0, 0, 48, 68); if ('symbol' in value) card(c, value); else domino(c, value); }, [value]);
  return <canvas ref={ref} width={isCard ? 48 : 44} height={isCard ? 68 : 24} aria-hidden="true" />;
}
function Board({ view, assets, disabled, move }: { view: GameView; assets: Assets; disabled: boolean; move(m: unknown): void }) {
  const ref = useRef<HTMLCanvasElement>(null), [from, setFrom] = useState<number | null>(null), [path, setPath] = useState<number[]>([]), [promotion, setPromotion] = useState<number | null>(null);
  const chess = view.game === 'chess' ? view.state : null, checkers = view.game === 'draughts' ? view.state : null;
  const choices = checkers?.legal.filter(m => m.from === from && path.every((q, i) => m.path[i] === q)) ?? [];
  const targets = chess ? chess.legal.filter(m => squareIndex(m.from) === from).map(m => squareIndex(m.to)) : choices.map(m => m.path[path.length]);
  useEffect(() => { setFrom(null); setPath([]); setPromotion(null); }, [view.state.ply]);
  useEffect(() => { if (ref.current) board(ref.current.getContext('2d')!, assets, view, from, targets, path); }, [assets, view, from, path, targets]);
  function pick(q: number) {
    if (disabled) return;
    if (chess) {
      const options = chess.legal.filter(m => squareIndex(m.from) === from && squareIndex(m.to) === q);
      if (options.length) { if (options.some(m => m.promotion)) setPromotion(q); else move(options[0]); return; }
      setFrom(chess.legal.some(m => squareIndex(m.from) === q) ? q : null);
    } else if (checkers) {
      if (targets.includes(q)) {
        const next = [...path, q], complete = choices.find(m => JSON.stringify(m.path) === JSON.stringify(next));
        if (complete) move(complete); else setPath(next);
      } else { setFrom(checkers.legal.some(m => m.from === q) ? q : null); setPath([]); }
    }
  }
  return <><div className="table-board"><canvas ref={ref} width={256} height={256} aria-hidden="true" /><div className="table-squares" role="group" aria-label="Board squares">
    {Array.from({ length: 64 }, (_, q) => <button key={q} disabled={disabled} aria-label={`${squareName(q)}${targets.includes(q) ? ', legal landing' : ''}`} aria-pressed={from === q || path.includes(q)} onClick={() => pick(q)} />)}
  </div></div><p className="table-hint">{disabled ? 'Watch the board.' : from === null ? 'Pick a piece, then its destination.' : path.length ? 'Continue the capture.' : 'Pick a highlighted destination.'}</p>
    {promotion !== null && <div className="table-actions" role="group" aria-label="Promote pawn">{(['q','r','b','n'] as const).map((p, i) => <button key={p} disabled={disabled} onClick={() => { move({ from: squareName(from!), to: squareName(promotion), promotion: p }); setPromotion(null); }}>{['Queen','Rook','Bishop','Knight'][i]}</button>)}<button className="ghost" onClick={() => setPromotion(null)}>Cancel</button></div>}
  </>;
}
function DominoChain({ chain }: { chain: Domino[] }) {
  const ref = useRef<HTMLCanvasElement>(null), height = Math.max(60, Math.ceil(chain.length / 8) * 52);
  useEffect(() => { const c = ref.current!.getContext('2d')!; c.clearRect(0, 0, 400, height); chain.forEach((t, i) => domino(c, t, 4 + i % 8 * 49, 4 + (i / 8 | 0) * 52, t.a === t.b)); }, [chain, height]);
  return <canvas className="table-chain" ref={ref} width={400} height={height} role="img" aria-label={chain.length ? `Chain: ${chain.map(t => `${t.a}-${t.b}`).join(', ')}` : 'Empty chain'} />;
}
export function TableOverlay({ store, assets }: { store: Store; assets: Assets }) {
  const v = store.table!, m = v.match, root = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<TableGameId>('chess'), [invites, setInvites] = useState<string[]>([]), [selected, setSelected] = useState<number | null>(null);
  const [wild, setWild] = useState<Card | null>(null), [lastCard, setLastCard] = useState(false), [now, setNow] = useState(store.now());
  const host = v.host === store.me, owner = store.connected && store.voiceOwner, live = !!m && !m.state.result;
  const player = m?.players.indexOf(store.me) ?? -1, active = player >= 0 && !m?.out.includes(store.me), turn = live && active && m?.state.turn === player;
  const disabled = !owner || !turn, invitation = v.invitation;
  useEffect(() => { const old = document.activeElement; root.current?.focus(); const timer = setInterval(() => setNow(store.now()), 250); return () => { clearInterval(timer); if (old instanceof HTMLElement && old.isConnected) old.focus(); }; }, [store]);
  useEffect(() => { setSelected(null); setWild(null); setLastCard(false); }, [v.revision]);
  useEffect(() => { setInvites([]); }, [game]);
  const move = (value: unknown) => store.tableMove(value);
  const playCard = (c: Card, colour?: Colour) => { if (!c.colour && !colour) setWild(c); else move({ kind: 'play', card: c.id, colour, lastCard }); };
  const dominoState = m?.game === 'dominoes' ? m.state : null, cards = m?.game === 'lastcard' ? m.state : null;
  const peers = v.sitters.filter(id => id !== store.me), max = game === 'chess' || game === 'draughts' ? 1 : 3;
  return <div ref={root} className="park-overlay table-overlay" role="dialog" aria-modal="true" aria-label="Game table" tabIndex={-1} onKeyDown={e => {
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const buttons = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),select,input')], first = buttons[0], last = buttons.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }}>
    <header className="park-header"><div className="party-heading"><h1>GAME TABLE</h1><span>{m ? TABLE_GAMES[m.game] : 'Take a seat'} · Host: {store.name(v.host)}</span></div><button className="ghost park-leave" disabled={!owner} onClick={() => store.tableLeave()}>Leave table</button></header>
    <div className="table-scroll">
      {!store.connected && <p role="status">Reconnecting… Your turn clock keeps running.</p>}
      <div className="table-people" aria-label="At the table">{v.sitters.map(id => <span key={id}>{store.name(id)}{id === store.me ? ' (you)' : ''}{id === v.host ? ' · host' : ''}</span>)}<span>{v.watchers.length} watching</span></div>
      {m && <>
        <p className="table-turn" role="status" aria-live="polite">{m.state.result ? m.state.result.winner === null ? `Draw · ${m.state.result.reason}` : `${store.name(m.players[m.state.result.winner])} wins · ${m.state.result.reason}` : `${store.name(m.players[m.state.turn])}'s turn${turn ? ' · your move' : active ? '' : ' · watching'}`}</p>
        {live && v.turnDeadline !== null && <p className="table-clock" role="timer">{Math.max(0, Math.ceil((v.turnDeadline - now) / 1000))}s left · 2 minutes per turn</p>}
        <div className="table-roster">{m.players.map((id, i) => <span key={id}>{store.name(id)}{m.game === 'chess' || m.game === 'draughts' ? i === 0 ? ' · white' : ' · black' : ` · ${m.state.counts[i]} in hand`}{m.out.includes(id) ? ' · out' : ''}</span>)}</div>
        {(m.game === 'chess' || m.game === 'draughts') && <Board key={m.id} view={m} assets={assets} disabled={disabled} move={move} />}
        {m.game === 'chess' && m.state.check && live && <p role="status">Check</p>}
        {dominoState && <><DominoChain chain={dominoState.chain} /><p>Boneyard: {dominoState.boneyard} · {dominoState.chain.length ? `Open ends: ${dominoState.chain[0].a} / ${dominoState.chain.at(-1)!.b}` : 'The highest double opens; otherwise the highest tile.'}</p>
          {dominoState.hand && <><div className="table-hand" role="group" aria-label="Your dominoes">{dominoState.hand.map(t => <button key={t.id} disabled={disabled || !dominoState.legal?.some(m => m.tile === t.id)} aria-label={`${t.a}-${t.b}`} aria-pressed={selected === t.id} onClick={() => setSelected(t.id)}><TileCanvas value={t} /></button>)}</div>
            <div className="table-actions">{(['left','right'] as const).map(end => <button key={end} disabled={disabled || !dominoState.legal?.some(m => m.tile === selected && m.end === end)} onClick={() => move({ kind: 'play', tile: selected, end })}>Play {end}</button>)}<button disabled={disabled || !!dominoState.legal?.length || !dominoState.boneyard} onClick={() => move({ kind: 'draw' })}>Draw</button><button disabled={disabled || !!dominoState.legal?.length || !!dominoState.boneyard} onClick={() => move({ kind: 'pass' })}>Pass</button></div></>}
        </>}
        {cards && <><div className="table-discard"><button className="table-discard-target" disabled={disabled || !cards.hand?.some(c => c.id === selected)} aria-label="Play selected card on the discard" onClick={() => { const c = cards.hand?.find(c => c.id === selected); if (c) playCard(c); }}><TileCanvas value={cards.top} /></button><span>Current colour: {cards.colour}<br />{cards.direction === 1 ? 'Clockwise' : 'Counterclockwise'} · {cards.pile} to draw</span></div>
          {cards.hand && <><div className="table-hand" role="group" aria-label="Your cards">{cards.hand.map(c => <button key={c.id} disabled={disabled || !cards.playable?.includes(c.id)} aria-label={cardLabel(c)} aria-pressed={selected === c.id} onClick={() => setSelected(c.id)}><TileCanvas value={c} /></button>)}</div>
            <div className="table-actions"><button disabled={disabled || selected === null} onClick={() => { const c = cards.hand?.find(c => c.id === selected); if (c) playCard(c); }}>Play card</button><button disabled={disabled || cards.drawn !== null} onClick={() => move({ kind: 'draw' })}>Draw</button><button disabled={disabled || cards.drawn === null} onClick={() => move({ kind: 'pass' })}>Pass</button><button disabled={disabled} aria-pressed={lastCard} onClick={() => setLastCard(!lastCard)}>Last card!</button>
              <button disabled={!owner || !live || cards.catchable === null || cards.catchable === player} onClick={() => move({ kind: 'catch' })}>Catch!</button></div><p className="table-hint">Select a card, then click the discard or Play card. Last card! declares your next play. After drawing, play that card or Pass.</p></>}
          {wild && <div className="table-actions" role="group" aria-label="Choose wild colour">{COLOURS.map(colour => <button key={colour} disabled={disabled} style={{ backgroundColor: CARD_COLOURS[colour], color: colour === 'yellow' ? '#2b2534' : '#fff0d3' }} onClick={() => playCard(wild, colour)}>{colour}</button>)}<button className="ghost" onClick={() => setWild(null)}>Cancel</button></div>}
          {cards.catchable !== null && live && <p role="status">{store.name(m.players[cards.catchable])} did not call Last card!</p>}
        </>}
        {live && active && <div className="table-actions">{(m.game === 'chess' || m.game === 'draughts') && (m.drawOffer && m.drawOffer !== store.me ? <><span>{store.name(m.drawOffer)} offers a draw.</span><button disabled={!owner} onClick={() => store.tableDraw(true)}>Accept draw</button><button disabled={!owner} onClick={() => store.tableDraw(false)}>Decline draw</button></> : <button disabled={!owner || !!m.drawOffer} onClick={() => store.tableDraw(true)}>{m.drawOffer ? 'Draw offered' : 'Offer draw'}</button>)}<button className="ghost" disabled={!owner} onClick={() => store.tableResign()}>Resign</button></div>}
      </>}
      {!live && host && <section className="table-host" aria-label="Choose a game"><label>Game <select value={game} disabled={!owner || !!invitation} onChange={e => setGame(e.target.value as TableGameId)}>{Object.entries(TABLE_GAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        {!invitation && <><p>Invite {max === 1 ? 'one sitter' : '1–3 sitters'}. They have 30 seconds to Join.</p><div className="table-actions">{peers.map(id => <label key={id}><input type="checkbox" checked={invites.includes(id)} disabled={!owner || (!invites.includes(id) && invites.length >= max)} onChange={() => setInvites(invites.includes(id) ? invites.filter(p => p !== id) : [...invites, id])} />{store.name(id)}</label>)}</div>
          <div className="table-actions"><button disabled={!owner || !invites.length} onClick={() => store.tablePick(game, invites)}>Invite to {TABLE_GAMES[game]}</button>{m && <button disabled={!owner || m.players.some(id => !v.sitters.includes(id))} onClick={() => store.tablePick(m.game, undefined, true)}>Rematch</button>}</div></>}
      </section>}
      {invitation && <section className="table-host" aria-label="Match invitation"><p>{invitation.rematch ? 'Rematch' : TABLE_GAMES[invitation.game]} · Join within {Math.max(0, Math.ceil((invitation.until - now) / 1000))}s</p><p>{invitation.invited.map(id => `${store.name(id)}: ${invitation.accepted.includes(id) ? 'ready' : 'invited'}`).join(' · ')}</p>
        {host ? <button disabled={!owner || invitation.accepted.length < 2 || (invitation.rematch && invitation.invited.some(id => !invitation.accepted.includes(id)))} onClick={() => store.tableStart()}>Start {TABLE_GAMES[invitation.game]}</button> : invitation.invited.includes(store.me) && <button disabled={!owner || invitation.accepted.includes(store.me)} onClick={() => store.tableStart()}>{invitation.accepted.includes(store.me) ? 'Joined · waiting for host' : 'Join'}</button>}
      </section>}
      {!live && !host && !invitation && <p className="table-hint">{v.sitters.includes(store.me) ? 'The host picks a game and invites sitters.' : 'The four seats are full. You have the public view.'}</p>}
    </div>
  </div>;
}
