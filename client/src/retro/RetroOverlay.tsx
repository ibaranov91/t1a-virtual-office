import { useEffect, useRef, useState } from 'react';
import type { Store } from '../net';
import { prefs, savePrefs, subscribePrefs } from '../prefs';
import { games } from '../../../shared/retro/games';
import { RetroInput } from './input';
const COMPACT = '(max-width: 560px), (max-height: 500px)';
const LEGEND = 'D-pad: arrows / WASD · A: Z / J / Space (unless push-to-talk) · B: X / K · Start: Enter · Select: Shift';
export function RetroOverlay({ store }: { store: Store }) {
  const client = store.retroClient, view = store.retro!;
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), area = useRef<HTMLDivElement>(null);
  const input = useRef<RetroInput | null>(null);
  const [page, setPage] = useState<'menu' | 'controls' | 'credits'>('menu'), [scale, setScale] = useState(1);
  const [, prefsChanged] = useState(0);
  useEffect(() => subscribePrefs(() => prefsChanged(n => n + 1)), []);
  const silent = prefs.retroMuted || !prefs.retroVolume;
  const [touch, setTouch] = useState(() => navigator.maxTouchPoints > 0 || matchMedia(COMPACT).matches);
  const game = games[view.game], spectator = view.kind !== 'playing' || view.role !== 'player';
  const toggle = () => { client.setMenu(!client.menu); setPage('menu'); input.current?.refresh(); root.current?.focus(); };
  const actions = useRef(toggle); actions.current = toggle;
  useEffect(() => {
    const previous = document.activeElement; root.current?.focus();
    const device = matchMedia(COMPACT), changed = () => setTouch(navigator.maxTouchPoints > 0 || device.matches);
    const pause = () => client.pause();
    window.addEventListener('blur', pause); document.addEventListener('visibilitychange', pause);
    device.addEventListener('change', changed);
    return () => { client.pause(); window.removeEventListener('blur', pause); document.removeEventListener('visibilitychange', pause); device.removeEventListener('change', changed); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const resize = () => { const r = area.current?.getBoundingClientRect(); if (r) setScale(Math.max(1, Math.floor(Math.min((r.width - 24) / 160, (r.height - 24) / 144)))); };
    const ro = new ResizeObserver(resize); if (area.current) ro.observe(area.current); resize();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const controls = new RetroInput(root.current!, {
      enabled: () => !!client.player && !client.reconnecting && !client.menu && !client.loading && !client.notice,
      ptt: () => prefs.mode === 'ptt', menu: () => actions.current(), spectator: () => !client.player,
    }); input.current = controls;
    const ctx = canvas.current!.getContext('2d')!;
    let raf = 0, lastGb = client.gb;
    const draw = () => { if (client.gb) ctx.putImageData(new ImageData(new Uint8ClampedArray(client.gb.screen()), 160, 144), 0, 0); };
    draw();
    const tick = (now: number) => {
      if (client.gb !== lastGb) { lastGb = client.gb; draw(); }
      client.tick(now, () => controls.sample(), draw); raf = requestAnimationFrame(tick);
    }; raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); controls.destroy(); input.current = null; };
  }, [client, store]);
  const loading = view.kind === 'starting' || client.loading;
  return <div ref={root} className="park-overlay retro-overlay" role="dialog" aria-modal="true" aria-label={game.title} tabIndex={-1}
    onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const items = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')], first = items[0], last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
    <header className="park-header retro-header"><div><h1>{game.title}</h1><span>{view.kind === 'playing' ? spectator ? `Watching ${store.name(view.player)}` : 'Playing' : 'Retro cabinet'}</span></div>
      <div className="volume-control retro-volume">
        <button className="ghost retro-mute" aria-pressed={prefs.retroMuted} aria-label={prefs.retroMuted ? 'Unmute game sound' : 'Mute game sound'}
          title={prefs.retroMuted ? 'Unmute game sound' : 'Mute game sound'} onClick={() => { prefs.retroMuted = !prefs.retroMuted; savePrefs(); root.current?.focus(); }}>{silent ? '🔇' : '🔊'}</button>
        <input type="range" min="0" max="100" step="5" value={prefs.retroMuted ? 0 : Math.round(prefs.retroVolume * 100)} aria-label="Game volume for me"
          onChange={e => { prefs.retroVolume = Number(e.target.value) / 100; prefs.retroMuted = false; savePrefs(); }}
          onPointerUp={() => root.current?.focus()} /><output>{prefs.retroMuted ? 0 : Math.round(prefs.retroVolume * 100)}%</output>
      </div>
      <button className="ghost" aria-expanded={client.menu} onClick={toggle}>Menu</button>
      <button className="ghost" onClick={() => store.retroLeave()}>Leave</button></header>
    <div className="park-area retro-area" ref={area} onPointerDown={e => { if (e.target === e.currentTarget || e.target === canvas.current) root.current?.focus(); }}>
      <div className="park-cabinet retro-bezel"><canvas ref={canvas} width={160} height={144} style={{ width: 160 * scale, height: 144 * scale }} aria-label={`${game.title} screen`} /></div>
      {(loading || client.error || view.kind === 'vacant' || client.notice || client.reconnecting) && <div className="park-menu-backdrop"><div className="park-menu retro-status" role="status">
        {client.reconnecting ? <b>Reconnecting…</b> : client.notice ? <b>{client.notice}</b> : client.error ? <><b>The game didn't load</b><button onClick={() => store.retroResync()}>Retry</button></> : loading ? <b>Inserting cartridge…</b> : <><b>{client.departed ? `${client.departed} left · the cabinet is free` : 'The cabinet is free'}</b><button onClick={() => store.use(view.cabinet)}>Play</button></>}
        <button onClick={() => store.retroLeave()}>Leave</button>
      </div></div>}
      {client.menu && <div className="park-menu-backdrop"><div className="park-menu retro-menu" role="group" aria-label="Retro menu">
        {page === 'menu' ? <><b>Paused</b><button onClick={toggle}>Resume</button><button onClick={() => setPage('controls')}>Controls</button><button onClick={() => setPage('credits')}>Credits &amp; licences</button><button onClick={() => store.retroLeave()}>Leave</button></> : <>
          <button onClick={() => setPage('menu')}>Back</button>
          {page === 'controls' ? <><b>Controls</b><p>{game.controls}</p><p>{LEGEND}</p><p>Standard gamepad: D-pad / left stick · A: button 0 · B: buttons 1/2 · Select: 8 · Start: 9</p><p>Touch: D-pad, A, B, Start and Select below the screen.</p><p>Esc: menu · The game pauses when this menu is open, the tab is hidden or the window loses focus.</p></> : <><b>Credits &amp; licences</b>{Object.values(games).map(credit => <section key={credit.id}><h2>{credit.title}</h2>{credit.credits.map(line => <p key={line}>{line}</p>)}<p>{credit.licence}</p>{credit.links.map(link => <p key={link.url}><a href={link.url} target="_blank" rel="noreferrer">{link.label}</a></p>)}</section>)}<p>binjgb · © 2016 Ben Smith · MIT License</p><a href="https://github.com/binji/binjgb" target="_blank" rel="noreferrer">binjgb source &amp; MIT licence</a><a href="/retro/LICENSES.md" target="_blank" rel="noreferrer">ROM licences &amp; credits · Homebrew Hub</a></>}
        </>}
      </div></div>}
      {client.toast && <div className="retro-toast" role="status">{client.toast}</div>}
    </div>
    {!spectator && <div className="retro-legend"><p>{game.controls}</p><small>{LEGEND}</small></div>}
    {!spectator && touch && <div className="retro-touch" aria-label="Touch game controls">
      <div className="retro-dpad">{([['▲', 4, 'Up'], ['◀', 2, 'Left'], ['▼', 8, 'Down'], ['▶', 1, 'Right']] as const).map(([label, bits, name]) => touchButton(label, bits, name))}</div>
      <div className="retro-actions">{([['A', 16], ['B', 32], ['Start', 128], ['Select', 64]] as const).map(([label, bits]) => touchButton(label, bits, label))}</div>
    </div>}
  </div>;
  function touchButton(label: string, bits: number, name: string) {
    return <button key={bits} aria-label={name} disabled={client.menu || client.reconnecting || client.loading || !!client.notice}
      onContextMenu={e => e.preventDefault()} onPointerDown={e => { e.preventDefault(); root.current?.focus(); e.currentTarget.setPointerCapture(e.pointerId); input.current?.touch(e.pointerId, bits); }}
      onPointerUp={e => input.current?.touch(e.pointerId, 0)} onPointerCancel={e => input.current?.touch(e.pointerId, 0)} onLostPointerCapture={e => input.current?.touch(e.pointerId, 0)}>{label}</button>;
  }
}
