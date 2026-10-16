import { useEffect, useRef, useState } from 'react';
import type { Assets } from '../assets';
import type { Store } from '../net';
import { prefs } from '../prefs';
import type { Voice } from '../voice';
import { ParkInput } from './input';
import { CHEERS, parkTime, renderPark } from './render';
import { LEVELS } from '../../../shared/park/levels';
import { gameDef } from '../../../shared/arcade/registry';
import { ranked, weeklyTotal } from '../../../shared/arcade/weeks';
import { crewName } from '../../../shared/arcade/names';
import type { VoteOptions } from '../../../shared/arcade/vote';
import type { GameId } from '../../../shared/arcade/types';

const COMPACT = '(max-width: 560px), (max-height: 500px)';

export function ArcadeOverlay({ store, assets, voice }: { store: Store; assets: Assets; voice: Voice | null }) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), area = useRef<HTMLDivElement>(null);
  const input = useRef<ParkInput | null>(null), menuRef = useRef(false);
  const [menu, setMenu] = useState(false), [scale, setScale] = useState(1);
  const [touch, setTouch] = useState(() => navigator.maxTouchPoints > 0 || matchMedia(COMPACT).matches);
  const [, update] = useState(0);
  const [editingCrew, setEditingCrew] = useState(false), [draft, setDraft] = useState('');
  const [prediction, setPrediction] = useState(''), [favourite, setFavourite] = useState('');
  const loop = store.park!, runner = loop.runner, session = runner.session;
  const spectator = runner.slot === undefined;
  const view = session?.view, hub = view?.kind === 'sim' && view.game === 'hub' && !session?.set;
  const vote = view?.kind === 'sim' && view.game === 'vote' ? view.opts as VoteOptions : null;
  const favouriteScreen = view?.kind === 'screen' && view.screen === 'favourite' ? view : null;
  const canPredict = !!session?.set && spectator && !session.set.players.some(p => p.userId === store.me);
  useEffect(() => { setPrediction(''); setFavourite(''); setEditingCrew(false); }, [session?.epoch]);
  const toggleMenu = () => {
    menuRef.current = !menuRef.current; setMenu(menuRef.current);
    input.current?.refresh(); runner.setLocalBits(0);
  };
  const actions = useRef({ toggleMenu }); actions.current = { toggleMenu };
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus();
    const device = matchMedia(COMPACT), changed = () => setTouch(navigator.maxTouchPoints > 0 || device.matches);
    device.addEventListener('change', changed);
    return () => { device.removeEventListener('change', changed); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const r = area.current?.getBoundingClientRect(); if (!r) return;
      const fit = Math.min(Math.max(0, r.width - 16) / 320, Math.max(0, r.height - 16) / 216);
      setScale(Math.max(1, Math.floor(fit)));
    });
    if (area.current) ro.observe(area.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const controls = new ParkInput(root.current!, {
      enabled: () => store.gameOpen && store.connected && !menuRef.current,
      ptt: () => prefs.mode === 'ptt', menu: () => actions.current.toggleMenu(),
      spectator: () => runner.slot === undefined, cheer: kind => store.gameCheer(kind),
    });
    input.current = controls;
    let last = '';
    const ctx = canvas.current!.getContext('2d')!;
    const stop = loop.start(() => controls.sample(), () => {
      renderPark(ctx, assets, runner, store);
      // The spectator's epoch changes 150 ms after receipt; React follows the presented session.
      const s = runner.session, next = `${s?.epoch}:${s?.view.kind}:${runner.slot}:${s?.players.length}:${s?.crew.name}:${s?.view.kind === 'screen' ? JSON.stringify(s.view.data.votes) : ''}:${Math.floor(runner.serverNow / 250)}`;
      if (next !== last) { last = next; update(n => n + 1); }
    });
    return () => { stop(); controls.destroy(); input.current = null; };
  }, [loop, store, assets, runner]);
  const leave = () => store.gameLeave();
  const command = (op: 'lobby' | 'restart') => { store.gameMenu(op); toggleMenu(); root.current?.focus(); };
  const owner = store.connected && store.voiceOwner;
  return <div ref={root} className="park-overlay" role="dialog" aria-modal="true" aria-label="Arcade" tabIndex={-1}
    onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const buttons = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
    <header className="park-header">
      <div className="party-heading"><h1>{session?.set ? `BREAK SET · ${session.set.mode === '2v2' ? 'RED / BLUE' : 'FFA'}` : 'ARCADE'}</h1>
        <span>{session?.crew.name}{session?.set?.mode === '2v2' ? ` · ${session.set.players.find(p => p.userId === store.me)?.team === 0 ? 'Red' : session.set.players.find(p => p.userId === store.me)?.team === 1 ? 'Blue' : 'Red / Blue'}` : ''}</span>{hub && !spectator && <button className="ghost" aria-label="Edit crew name" onClick={() => { setDraft(session?.crew.name ?? ''); setEditingCrew(true); }}>✏</button>}</div>
      <button disabled={!owner || !voice} aria-pressed={voice?.muted ?? true} aria-label={voice?.muted ? 'Unmute microphone' : 'Mute microphone'}
        className={voice?.muted ? 'muted-btn' : 'ghost'} title={voice?.micError ?? (voice?.mode === 'ptt' ? 'Push to talk: hold Space' : 'Microphone')}
        onClick={() => voice?.toggleMute()}>{voice?.muted ? '🔇' : '🎙'}</button>
      <button disabled={!owner || !voice} aria-pressed={voice?.deafened ?? prefs.deafened} aria-label={voice?.deafened ? 'Undeafen' : 'Deafen'}
        className={voice?.deafened ? 'muted-btn' : 'ghost'} onClick={() => voice?.toggleDeafen()}>🎧</button>
      <button className="ghost" aria-expanded={menu} aria-label="Game menu" onClick={toggleMenu}>⏸</button>
      <button className="ghost park-leave" aria-label="Leave game" title="Leave the game (Esc for the menu)" onClick={leave}>✕ Leave</button>
    </header>
    <div className="park-area" ref={area} onPointerDown={e => { if (e.target === e.currentTarget || e.target === canvas.current) root.current?.focus(); }}>
      <div className="park-cabinet"><canvas ref={canvas} width={320} height={216} style={{ width: 320 * scale, height: 216 * scale }} aria-label="Arcade game. Move with arrows or WASD. Jump: Space, Z or J. Action: X, K or Shift." /></div>
      {!store.connected && <div className="park-connection" role="status">Reconnecting…</div>}
      {menu && <div className="park-menu-backdrop"><div className="park-menu" role="group" aria-label="Game menu">
        <b>{session?.set ? 'Break Set' : 'Paused controls'}</b>
        {!session?.set && <button onClick={toggleMenu}>Resume</button>}
        {!spectator && !session?.set && view?.kind === 'sim' && view.game === 'park' && <>
          <button disabled={!store.connected} onClick={() => command('lobby')}>Back to lobby</button>
          <button disabled={!store.connected} onClick={() => command('restart')}>Restart level</button>
        </>}
        {spectator && hub && session && session.players.length < 4 &&
          <button disabled={!store.connected} onClick={() => { store.gamePlay(); toggleMenu(); root.current?.focus(); }}>Play</button>}
        <button onClick={leave}>Leave</button>
      </div></div>}
    </div>
    {editingCrew && hub && <form className="party-crew-edit" onSubmit={e => { e.preventDefault(); if (crewName(draft)) { store.crewName(draft); setEditingCrew(false); root.current?.focus(); } }}>
      <label>Crew name<input autoFocus maxLength={40} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEditingCrew(false); root.current?.focus(); } }} /></label>
      <button disabled={!owner || !crewName(draft)}>Save</button><button type="button" className="ghost" onClick={() => { setEditingCrew(false); root.current?.focus(); }}>Cancel</button>
      {!crewName(draft) && <small role="status">Use 1–20 letters, digits, spaces or -'!&.</small>}
    </form>}
    {canPredict && vote && runner.serverNow < vote.closesAt && <div className="party-voters" role="group" aria-label="Predict the round winner">
      <span>Predict the winner</span>{session?.players.map(p => <button key={p.userId} disabled={!owner} aria-pressed={prediction === p.userId} onClick={() => { setPrediction(p.userId); store.gamePredict(p.userId); }}>{store.name(p.userId)}</button>)}
    </div>}
    {favouriteScreen?.data.voters?.includes(store.me) && runner.serverNow < favouriteScreen.until && <div className="party-voters" role="group" aria-label="Vote for crowd favourite">
      <span>Your favourite · +1</span>{favouriteScreen.data.candidates?.map(id => <button key={id} disabled={!owner} aria-pressed={favourite === id} onClick={() => { setFavourite(id); store.gameFavourite(id); }}>{store.name(id)} · {favouriteScreen.data.votes?.[id] ?? 0}</button>)}
    </div>}
    {spectator ? <div className="park-cheers" aria-label="Cheer">
      {CHEERS.map((emoji, kind) => <button key={emoji} disabled={!store.connected || menu} aria-label={`${['Applause', 'Fire', 'Laugh'][kind]} (key ${kind + 1})`}
        onClick={() => store.gameCheer(kind as 0 | 1 | 2)}>{emoji} <small>{kind + 1}</small></button>)}
    </div> : touch && <div className="park-touch" aria-label="Touch game controls">
      {([['◀', 1, 'Move left'], ['▶', 2, 'Move right'], ['▲', 4, 'Move up'], ['▼', 8, 'Move down'], ['Jump', 16, 'Jump'], ['Action', 32, 'Action']] as const).map(([label, bits, name]) => <button key={bits} aria-label={name} disabled={menu}
        onContextMenu={e => e.preventDefault()} onPointerDown={e => {
          e.preventDefault(); root.current?.focus(); e.currentTarget.setPointerCapture(e.pointerId); input.current?.touch(e.pointerId, bits);
        }} onPointerUp={e => input.current?.touch(e.pointerId, 0)} onPointerCancel={e => input.current?.touch(e.pointerId, 0)}
        onLostPointerCapture={e => input.current?.touch(e.pointerId, 0)}>{label}</button>)}
    </div>}
  </div>;
}

export function RecordsPopover({ store }: { store: Store }) {
  const ref = useRef<HTMLDivElement>(null), [tab, setTab] = useState('This week');
  const tabs = ['This week', 'Champions', 'Oracle', 'Table', 'Deck Park', 'Hall of Fame'];
  useEffect(() => { const previous = document.activeElement; ref.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const close = () => store.openRecords(false), boards = store.arcadeBoards;
  const names = (id: string) => boards.week.players[id]?.name ?? store.name(id);
  const ranking = (values: Record<string, number>, label: string) => Object.keys(values).length ? <table><caption className="sr-only">{label}</caption><thead><tr><th>Rank</th><th>Player</th><th>{label}</th></tr></thead><tbody>{ranked(values).map(r => <tr key={r.userId}><td>{r.rank}</td><td>{names(r.userId)}</td><td>{r.value}</td></tr>)}</tbody></table> : <p className="muted">No scores yet.</p>;
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={ref} tabIndex={-1} className="meet-panel guided park-records" role="dialog" aria-modal="true" aria-label="Arcade boards"
      onKeyDown={e => {
        if (store.gameOpen) return;
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Tab') {
          const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button')], first = buttons[0], last = buttons.at(-1);
          if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}>
      <div className="rooms-head"><span>Arcade boards</span><button className="ghost" onClick={close} aria-label="Close boards">×</button></div>
      <nav className="party-tabs" aria-label="Arcade boards">{tabs.map(name => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
      <div className="park-records-scroll">
        {tab === 'This week' && <><p>Week of {boards.week.key || '…'} · Europe/Warsaw · best 10 sets</p>{ranking(Object.fromEntries(Object.entries(boards.week.players).map(([id, p]) => [id, weeklyTotal(p)])), 'Points')}</>}
        {tab === 'Oracle' && ranking(boards.week.oracle, 'Correct predictions')}
        {tab === 'Table' && <p className="muted">No table results yet.</p>}
        {tab === 'Champions' && <>{Object.keys(boards.week.champions).length ? Object.entries(boards.week.champions).map(([id, wins]) => <section key={id}><h3>King of {gameDef(id as GameId).name}</h3>{ranking(wins, 'Round wins')}</section>) : <p className="muted">Finish a Break Set to crown a champion.</p>}</>}
        {tab === 'Hall of Fame' && (boards.hall.length ? <table><thead><tr><th>Week</th><th>Champion</th><th>Points</th></tr></thead><tbody>{boards.hall.slice().reverse().map(r => <tr key={`${r.week}:${r.userId}`}><td>{r.week}</td><td>{r.name}</td><td>{r.points}</td></tr>)}</tbody></table> : <p className="muted">Weekly champions will appear here.</p>)}
        {tab === 'Deck Park' && <table><caption className="sr-only">Best co-op runs by level and team size</caption>
          <thead><tr><th scope="col">Level</th>{[1, 2, 3, 4].map(n => <th key={n} scope="col">{n} {n === 1 ? 'player' : 'players'}</th>)}</tr></thead>
          <tbody>{LEVELS.slice(1).map(level => <tr key={level.id}><th scope="row">{level.id}. {level.name}</th>
            {([1, 2, 3, 4] as const).map(team => { const r = store.arcadeRecords[level.id]?.[team]; return <td key={team}>{r ? <><b>{parkTime(r.frames)}</b><span>{r.coins} coins</span>{r.crew && <span>{r.crew}</span>}<small>{r.names.join(', ')}</small></> : <span className="park-no-record">No record yet</span>}</td>; })}</tr>)}</tbody>
        </table>}
      </div>
    </div>
  </div>;
}
