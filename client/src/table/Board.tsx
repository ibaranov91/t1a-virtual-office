import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Chess } from 'chess.js';
import type { ChessMove, ChessView } from '../../../shared/table/chess';
import type { DraughtsView } from '../../../shared/table/draughts';
import { PIECES, PIECE_NAMES } from './art';
import { cellSquare, squareIndex, squareName } from './model';

type BoardView = { game: 'chess'; state: ChessView } | { game: 'draughts'; state: DraughtsView };
interface Target { q: number; capture: boolean }
const PROMOTIONS = ['q', 'n', 'r', 'b'] as const;

/** Chess or checkers board, chess.com style: click-click or drag, turned toward the player. */
export function Board({ view, flipped, size, disabled, move }: { view: BoardView; flipped: boolean; size: number; disabled: boolean; move(m: unknown): void }) {
  const chess = view.game === 'chess' ? view.state : null, draughts = view.game === 'draughts' ? view.state : null;
  const [from, setFrom] = useState<number | null>(null), [path, setPath] = useState<number[]>([]);
  const [promotion, setPromotion] = useState<number | null>(null), [focus, setFocus] = useState(flipped ? 4 : 60);
  const [hover, setHover] = useState<number | null>(null), [dragging, setDragging] = useState(false);
  const root = useRef<HTMLDivElement>(null), ghost = useRef<HTMLImageElement>(null), cells = useRef<(HTMLButtonElement | null)[]>([]);
  const press = useRef<{ q: number; x: number; y: number; at: [number, number]; was: boolean } | null>(null), dropped = useRef(false), seenPly = useRef(view.state.ply);
  const square = size / 8;

  // What stands where: 'wp', 'bk', 'wman', 'bking' … indexed a8 = 0.
  const pieces = useMemo(() => chess ? new Chess(chess.fen).board().flat().map(p => p ? `${p.color}${p.type}` : null)
    : draughts!.board.map(p => p ? `${p > 0 ? 'w' : 'b'}${Math.abs(p) === 2 ? 'king' : 'man'}` : null), [chess, draughts]);
  const movable = useMemo(() => new Set(chess ? chess.legal.map(m => squareIndex(m.from)) : draughts!.legal.map(m => m.from)), [chess, draughts]);
  const choices = useMemo(() => draughts && from !== null ? draughts.legal.filter(m => m.from === from && path.every((q, i) => m.path[i] === q)) : [], [draughts, from, path]);
  const targets: Target[] = useMemo(() => {
    if (from === null) return [];
    if (chess) {
      const seen = new Set<number>();
      return chess.legal.filter(m => squareIndex(m.from) === from).flatMap(m => {
        const q = squareIndex(m.to); if (seen.has(q)) return []; seen.add(q);
        return [{ q, capture: !!pieces[q] || (pieces[from]?.[1] === 'p' && m.from[0] !== m.to[0]) }];
      });
    }
    // Checkers: offer each final landing square; where two routes end on the same square, also offer the next hop.
    const ends = choices.map(m => m.path.at(-1)!), twice = ends.filter((q, i) => ends.indexOf(q) !== i);
    const qs = new Set([...ends.filter(q => !twice.includes(q)), ...(twice.length ? choices.map(m => m.path[path.length]) : [])]);
    return [...qs].map(q => ({ q, capture: false }));
  }, [chess, choices, from, path, pieces]);
  const last = chess ? (m => m && [squareIndex(m.from), squareIndex(m.to)])(chess.moves.at(-1))
    : (m => m && [m.from, m.path.at(-1)!])(draughts!.moves.at(-1));
  const checked = chess?.check ? pieces.indexOf(chess.turn === 0 ? 'wk' : 'bk') : -1;

  // The last move slides in, unless this player just dropped it there by hand.
  const arrive = useRef<{ q: number; dx: number; dy: number; ply: number } | null>(null);
  if (view.state.ply !== seenPly.current) {
    seenPly.current = view.state.ply;
    arrive.current = last && !dropped.current ? (() => {
      const [a, b] = [last[0], last[1]].map(q => flipped ? 63 - q : q);
      return { q: last[1], dx: (a % 8) - (b % 8), dy: (a / 8 | 0) - (b / 8 | 0), ply: view.state.ply };
    })() : null;
    dropped.current = false;
  }
  useEffect(() => { setFrom(null); setPath([]); setPromotion(null); }, [view.state.ply]);
  useLayoutEffect(() => { if (disabled) { setFrom(null); setPath([]); setPromotion(null); } }, [disabled]);

  function play(q: number) {
    if (chess) {
      const options = chess.legal.filter(m => squareIndex(m.from) === from && squareIndex(m.to) === q);
      if (!options.length) return false;
      if (options.some(m => m.promotion)) { setPromotion(q); return true; }
      move(options[0]); return true;
    }
    const exact = choices.filter(m => m.path.at(-1) === q);
    if (exact.length === 1) { move(exact[0]); return true; }
    if (choices.some(m => m.path[path.length] === q)) {
      // A capture can't stop while another hop is open, so a move that ends here is the whole move.
      const next = [...path, q], done = choices.find(m => m.path.length === next.length && m.path.every((p, i) => p === next[i]));
      if (done) move(done); else setPath(next);
      return true;
    }
    return false;
  }
  function pick(q: number) {
    if (disabled || promotion !== null) return;
    if (from !== null && targets.some(t => t.q === q) && play(q)) return;
    setPath([]); setFrom(movable.has(q) && q !== from ? q : null);
  }

  const cellAt = (x: number, y: number) => {
    const r = root.current!.getBoundingClientRect(), col = Math.floor((x - r.left) / (r.width / 8)), row = Math.floor((y - r.top) / (r.height / 8));
    return col < 0 || col > 7 || row < 0 || row > 7 ? null : row * 8 + col;
  };
  const place = (x: number, y: number) => { if (ghost.current) ghost.current.style.transform = `translate(${x - square / 2}px, ${y - square / 2}px)`; };
  function down(e: ReactPointerEvent, q: number) {
    if (e.button !== 0 || disabled || promotion !== null) return;
    if (from !== null && targets.some(t => t.q === q)) { e.preventDefault(); play(q); return; }
    if (!movable.has(q)) { setFrom(null); setPath([]); return; }
    e.preventDefault(); root.current?.setPointerCapture(e.pointerId);
    press.current = { q, x: e.clientX, y: e.clientY, at: [e.clientX, e.clientY], was: from === q }; setFrom(q); setPath([]); setFocus(flipped ? 63 - q : q);
  }
  function moveTo(e: ReactPointerEvent) {
    const p = press.current; if (!p) return;
    if (!dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return;
    if (!dragging) setDragging(true);
    p.at = [e.clientX, e.clientY]; place(e.clientX, e.clientY);
    const cell = cellAt(e.clientX, e.clientY); setHover(cell === null ? null : cellSquare(cell, flipped));
  }
  function up(e: ReactPointerEvent) {
    const p = press.current; press.current = null; if (!p) return;
    if (dragging) {
      setDragging(false); setHover(null);
      const cell = cellAt(e.clientX, e.clientY), q = cell === null ? null : cellSquare(cell, flipped);
      if (q !== null && q !== p.q && targets.some(t => t.q === q)) { dropped.current = true; if (!play(q)) dropped.current = false; }
    } else if (p.was) setFrom(null);
  }
  useLayoutEffect(() => { if (dragging && press.current) place(...press.current.at); });

  function key(e: React.KeyboardEvent) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[e.key];
    if (step !== undefined) {
      e.preventDefault(); e.stopPropagation();
      const col = focus % 8, next = focus + step;
      if (next < 0 || next > 63 || (step === -1 && col === 0) || (step === 1 && col === 7)) return;
      setFocus(next); cells.current[next]?.focus();
    } else if (e.key === 'Escape' && (from !== null || promotion !== null)) { e.stopPropagation(); setFrom(null); setPath([]); setPromotion(null); }
  }

  const mover = (chess?.turn ?? draughts!.turn) === 0 ? 'w' : 'b';
  const promoCell = promotion === null ? 0 : flipped ? 63 - promotion : promotion, promoDown = promoCell < 8;
  return <div ref={root} className={`gt-board${disabled ? '' : ' live'}${dragging ? ' dragging' : ''}`} style={{ width: size, height: size }}
    role="grid" aria-label={`${chess ? 'Chess' : 'Checkers'} board, ${flipped ? 'black' : 'white'} at the bottom`} onKeyDown={key}
    onPointerMove={moveTo} onPointerUp={up} onPointerCancel={() => { press.current = null; setDragging(false); setHover(null); }}>
    {Array.from({ length: 8 }, (_, row) => <div key={row} role="row" className="gt-rank">
      {Array.from({ length: 8 }, (_, col) => {
        const cell = row * 8 + col, q = cellSquare(cell, flipped), piece = pieces[q], name = squareName(q), target = targets.find(t => t.q === q);
        const light = (q % 8 + (q / 8 | 0)) % 2 === 0, a = arrive.current?.q === q ? arrive.current : null;
        const cls = ['gt-sq', light ? 'light' : 'dark', last?.includes(q) && 'last', (from === q || path.includes(q)) && 'selected', q === checked && 'check',
          target && (target.capture ? 'take' : 'to'), dragging && hover === q && target && 'hover', !disabled && movable.has(q) && 'movable'].filter(Boolean).join(' ');
        const label = `${name}${piece ? `, ${piece[0] === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.slice(1)]}` : ''}${target ? ', move here' : ''}`;
        return <button key={cell} ref={el => { cells.current[cell] = el; }} type="button" role="gridcell" className={cls} tabIndex={cell === focus ? 0 : -1}
          aria-label={label} aria-selected={from === q} aria-disabled={disabled || undefined}
          onPointerDown={e => down(e, q)} onClick={e => { if (e.detail === 0) pick(q); }} onFocus={() => setFocus(cell)}>
          {col === 0 && <span className="gt-coord rank">{name[1]}</span>}
          {row === 7 && <span className="gt-coord file">{name[0]}</span>}
          {piece && <img key={a ? `a${a.ply}` : 'p'} className={`gt-piece${a ? ' arrive' : ''}${dragging && from === q ? ' lifted' : ''}`} src={PIECES[piece]} alt="" draggable={false}
            style={a ? { '--dx': `${a.dx * 100}%`, '--dy': `${a.dy * 100}%` } as React.CSSProperties : undefined} />}
        </button>;
      })}
    </div>)}
    {dragging && from !== null && pieces[from] && <img ref={ghost} className="gt-ghost" src={PIECES[pieces[from]!]} alt="" style={{ width: square, height: square }} />}
    {promotion !== null && <div className="gt-promo-scrim" onPointerDown={e => { e.stopPropagation(); setPromotion(null); }}>
      <div className="gt-promo" role="group" aria-label="Promote pawn to" style={{ left: (promoCell % 8) * square, width: square, ...(promoDown ? { top: 0 } : { bottom: 0 }), flexDirection: promoDown ? 'column' : 'column-reverse' }}
        onPointerDown={e => e.stopPropagation()}>
        {PROMOTIONS.map((p, i) => <button key={p} type="button" style={{ height: square }} aria-label={['Queen', 'Knight', 'Rook', 'Bishop'][i]} autoFocus={i === 0}
          onClick={() => { move({ from: squareName(from!), to: squareName(promotion), promotion: p } satisfies ChessMove); setPromotion(null); }}>
          <img src={PIECES[`${mover}${p}`]} alt="" draggable={false} /></button>)}
      </div>
    </div>}
  </div>;
}
