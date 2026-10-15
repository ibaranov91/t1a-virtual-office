import { useEffect, useRef, useState } from 'react';
import type { Assets } from '../assets';
import type { Store } from '../net';
import { prefs } from '../prefs';
import type { Voice } from '../voice';
import { ParkInput } from './input';
import { CHEERS, parkTime, renderPark } from './render';
import { LEVELS } from '../../../shared/park/levels';

const COMPACT = '(max-width: 560px), (max-height: 500px)';

export function ArcadeOverlay({ store, assets, voice }: { store: Store; assets: Assets; voice: Voice | null }) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), area = useRef<HTMLDivElement>(null);
  const input = useRef<ParkInput | null>(null), menuRef = useRef(false);
  const [menu, setMenu] = useState(false), [scale, setScale] = useState(1);
  const [touch, setTouch] = useState(() => navigator.maxTouchPoints > 0 || matchMedia(COMPACT).matches);
  const [, update] = useState(0);
  const loop = store.park!, runner = loop.runner, session = runner.session;
  const spectator = runner.slot === undefined;
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
      setScale(fit >= 1 ? Math.floor(fit) : Math.max(.01, fit));
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
      const s = runner.session, next = `${s?.epoch}:${s?.phase}:${runner.slot}:${s?.players.length}`;
      if (next !== last) { last = next; update(n => n + 1); }
    });
    return () => { stop(); controls.destroy(); input.current = null; };
  }, [loop, store, assets, runner]);
  const leave = () => store.gameLeave();
  const command = (op: 'lobby' | 'restart') => { store.gameMenu(op); toggleMenu(); root.current?.focus(); };
  const owner = store.connected && store.voiceOwner;
  return <div ref={root} className="park-overlay" role="dialog" aria-modal="true" aria-label="Deck Park" tabIndex={-1}
    onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
    <header className="park-header">
      <h1>DECK PARK</h1>
      <button disabled={!owner || !voice} aria-pressed={voice?.muted ?? prefs.muted} aria-label={voice?.muted ? 'Unmute microphone' : 'Mute microphone'}
        className={voice?.muted ? 'muted-btn' : 'ghost'} title={voice?.micError ?? (voice?.mode === 'ptt' ? 'Push to talk: hold Space' : 'Microphone')}
        onClick={() => voice?.toggleMute()}>{voice?.muted ? '🔇' : '🎙'}</button>
      <button disabled={!owner || !voice} aria-pressed={voice?.deafened ?? prefs.deafened} aria-label={voice?.deafened ? 'Undeafen' : 'Deafen'}
        className={voice?.deafened ? 'muted-btn' : 'ghost'} onClick={() => voice?.toggleDeafen()}>🎧</button>
      <button className="ghost" aria-expanded={menu} aria-label="Game menu" onClick={toggleMenu}>⏸</button>
      <button className="ghost park-leave" aria-label="Leave game" title="Leave the game (Esc for the menu)" onClick={leave}>✕ Leave</button>
    </header>
    <div className="park-area" ref={area} onPointerDown={e => { if (e.target === e.currentTarget || e.target === canvas.current) root.current?.focus(); }}>
      <div className="park-cabinet"><canvas ref={canvas} width={320} height={216} style={{ width: 320 * scale, height: 216 * scale }} aria-label="Deck Park game. Move with arrows or A/D. Jump with Up, W, Z or Space." /></div>
      {!store.connected && <div className="park-connection" role="status">Reconnecting…</div>}
      {menu && <div className="park-menu-backdrop"><div className="park-menu" role="group" aria-label="Game menu">
        <b>Paused controls</b>
        <button onClick={toggleMenu}>Resume</button>
        {!spectator && session?.phase === 'level' && <>
          <button disabled={!store.connected} onClick={() => command('lobby')}>Back to lobby</button>
          <button disabled={!store.connected} onClick={() => command('restart')}>Restart level</button>
        </>}
        {spectator && session?.phase === 'lobby' && session.players.length < 4 &&
          <button disabled={!store.connected} onClick={() => { store.gamePlay(); toggleMenu(); root.current?.focus(); }}>Play</button>}
        <button onClick={leave}>Leave</button>
      </div></div>}
    </div>
    {spectator ? <div className="park-cheers" aria-label="Cheer">
      {CHEERS.map((emoji, kind) => <button key={emoji} disabled={!store.connected || menu} aria-label={`${['Applause', 'Fire', 'Laugh'][kind]} (key ${kind + 1})`}
        onClick={() => store.gameCheer(kind as 0 | 1 | 2)}>{emoji} <small>{kind + 1}</small></button>)}
    </div> : touch && <div className="park-touch" aria-label="Touch game controls">
      {([['◀', 1, 'Move left'], ['▶', 2, 'Move right'], ['⤒', 4, 'Jump']] as const).map(([label, bits, name]) => <button key={bits} aria-label={name} disabled={menu}
        onContextMenu={e => e.preventDefault()} onPointerDown={e => {
          e.preventDefault(); root.current?.focus(); e.currentTarget.setPointerCapture(e.pointerId); input.current?.touch(e.pointerId, bits);
        }} onPointerUp={e => input.current?.touch(e.pointerId, 0)} onPointerCancel={e => input.current?.touch(e.pointerId, 0)}
        onLostPointerCapture={e => input.current?.touch(e.pointerId, 0)}>{label}</button>)}
    </div>}
  </div>;
}

export function RecordsPopover({ store }: { store: Store }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement; ref.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const close = () => store.openRecords(false);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={ref} tabIndex={-1} className="meet-panel guided park-records" role="dialog" aria-modal="true" aria-label="Deck Park records"
      onKeyDown={e => { if (store.gameOpen) return; if (e.key === 'Escape') { e.stopPropagation(); close(); } if (e.key === 'Tab') { e.preventDefault(); ref.current?.querySelector('button')?.focus(); } }}>
      <div className="rooms-head"><span>Deck Park records</span><button className="ghost" onClick={close} aria-label="Close records">×</button></div>
      <div className="park-records-scroll"><table>
        <caption className="sr-only">Best runs by level and team size</caption>
        <thead><tr><th scope="col">Level</th>{[1, 2, 3, 4].map(n => <th key={n} scope="col">{n} {n === 1 ? 'player' : 'players'}</th>)}</tr></thead>
        <tbody>{LEVELS.slice(1).map(level => <tr key={level.id}><th scope="row">{level.id}. {level.name}</th>
          {([1, 2, 3, 4] as const).map(team => {
            const r = store.arcadeRecords[level.id]?.[team];
            return <td key={team}>{r ? <><b>{parkTime(r.frames)}</b><span>{r.coins} coins</span><small>{r.names.join(', ')}</small></> : <span className="park-no-record">No record yet</span>}</td>;
          })}</tr>)}</tbody>
      </table></div>
    </div>
  </div>;
}
