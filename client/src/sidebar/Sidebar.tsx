import { Icon } from '../Icon';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Assets } from '../assets';
import type { Engine } from '../engine';
import type { Store } from '../net';
import type { Voice } from '../voice';
import { subscribePrefs } from '../prefs';
import { useSpeaking } from './Avatar';
import { COMPACT, overlayOpen, popoverOpen, useMedia } from './hooks';
import { ChannelTree } from './ChannelTree';
import { PeopleList } from './PeopleList';
import { SelfPanel } from './SelfPanel';
import { Rail } from './Rail';
import type { PersonAnchor } from './PersonCard';
import type { RoomAnchor } from './RoomMenu';
export type { PersonAnchor } from './PersonCard';
type Settings = { width: number; collapsed: boolean; view: 'rooms' | 'people'; closed: string[] };
const WIDTH = 340; // fits the bottom card's name beside mic, headphones and settings
const defaults = (): Settings => ({ width: WIDTH, collapsed: false, view: 'rooms', closed: ['offline'] });
const clamp = (n: number) => Math.max(260, Math.min(400, n));
function load(): Settings {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem('deck.sidebar') ?? 'null');
    if (!s || typeof s !== 'object') return d;
    return { width: typeof s.width === 'number' && Number.isFinite(s.width) && s.width !== 264 ? clamp(s.width) : d.width, // 264 was the old default: never chosen by hand
      collapsed: typeof s.collapsed === 'boolean' ? s.collapsed : d.collapsed,
      view: s.view === 'people' ? 'people' : 'rooms', closed: Array.isArray(s.closed) && s.closed.every((id: unknown) => typeof id === 'string') ? s.closed : d.closed };
  } catch { return d; }
}
function save(s: Settings) { try { localStorage.setItem('deck.sidebar', JSON.stringify(s)); } catch { /* storage unavailable */ } }
export const Sidebar = forwardRef<{ close: () => void }, {
  store: Store; voice: Voice | null; engine: Engine | null; assets: Assets | null;
  onProfile: (opener: HTMLButtonElement) => void;
  sheetOpen?: boolean; onCloseSheet?: () => void; surfaceOpen: boolean;
  onPerson: (at: PersonAnchor) => void; onRoom: (at: RoomAnchor) => void;
}>(function Sidebar({ store, voice, engine, assets, sheetOpen, onCloseSheet, surfaceOpen, onPerson, onRoom, onProfile }, ref) {
  const compact = useMedia(COMPACT), narrow = useMedia('(max-width: 899px)');
  const [settings, setSettings] = useState(load), current = useRef(settings); current.current = settings;
  const [over, setOver] = useState(false), [full, setFull] = useState(false), [query, setQuery] = useState('');
  const [, tick] = useState(0), [scrollGroup, setScrollGroup] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null), panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null), grab = useRef<number | null>(null);
  const speaking = useSpeaking(store, engine);
  useEffect(() => subscribePrefs(() => tick(n => n + 1)), []);
  useEffect(() => { setOver(false); }, [narrow, compact]);
  const update = (patch: Partial<Settings>) => { const next = { ...current.current, ...patch }; current.current = next; setSettings(next); save(next); };
  const close = () => { setOver(false); onCloseSheet?.(); };
  useImperativeHandle(ref, () => ({ close }));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (overlayOpen(store) || e.key !== 'Escape' || surfaceOpen || popoverOpen() || e.defaultPrevented) return;
      if (compact && sheetOpen || !compact && narrow && over) { e.stopImmediatePropagation(); close(); }
    };
    const outside = (e: PointerEvent) => {
      if (!overlayOpen(store) && !compact && narrow && over && e.target instanceof Element && e.target.closest('.stage') && !e.target.closest('.sb-surface')) setOver(false);
    };
    window.addEventListener('keydown', key); window.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside); };
  }, [store, compact, narrow, over, sheetOpen, surfaceOpen, onCloseSheet]);
  useEffect(() => {
    if (!scrollGroup || !panel.current) return;
    panel.current.querySelector(`#sb-${scrollGroup}`)?.scrollIntoView({ block: 'nearest' }); setScrollGroup(null);
  }, [scrollGroup]);
  const expanded = compact ? !!sheetOpen : narrow ? over : !settings.collapsed;
  const expand = () => { if (narrow) setOver(true); else update({ collapsed: false }); };
  const collapse = () => { if (narrow) setOver(false); else update({ collapsed: true }); };
  const group = (id: string) => { update({ view: 'rooms', closed: settings.closed.filter(g => g !== id) }); setQuery(''); expand(); setScrollGroup(id); };
  const toggle = (id: string) => update({ closed: settings.closed.includes(id) ? settings.closed.filter(g => g !== id) : [...settings.closed, id] });
  const action = () => close();
  const list = { store, assets, speaking, query, closed: settings.closed, onToggle: toggle, onPerson, onAction: action };
  return <>
    {!compact && (narrow || settings.collapsed) && <Rail store={store} voice={voice} assets={assets} speaking={speaking} onExpand={expand} onGroup={group} onPerson={onPerson} onAction={action} />}
    {expanded && <aside ref={panel} className={`sidebar${compact ? ` sb-sheet${full ? ' full' : ''}` : narrow ? ' over' : ''}`} style={compact ? undefined : { width: settings.width }} aria-label="People and rooms">
      {compact && <button className="sb-grab" aria-label={full ? 'Half height' : 'Full height'} onPointerDown={e => { grab.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerUp={e => { const dy = e.clientY - (grab.current ?? e.clientY); grab.current = null; if (dy > 80) close(); else if (dy < -40) setFull(true); else if (Math.abs(dy) < 8) setFull(f => !f); }} onPointerCancel={() => { grab.current = null; }}><span /></button>}
      <header className="sb-header"><div role="tablist" aria-label="Sidebar view">{(['rooms', 'people'] as const).map(v => <button key={v} role="tab" aria-selected={settings.view === v} onClick={() => update({ view: v })}>{v === 'rooms' ? 'Rooms' : 'People'}</button>)}</div>
        <button className="ghost" aria-label={compact ? 'Close people' : 'Collapse sidebar'} onClick={compact ? close : collapse}><Icon name={compact ? "close" : "chevron-left"} /></button></header>
      <div className="sb-body"><input ref={search} className="sb-search" type="search" aria-label="Find a person or room" placeholder="Find a person or room" value={query} onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (!overlayOpen(store) && e.key === 'Escape' && !surfaceOpen && !popoverOpen()) { e.stopPropagation(); if (query) setQuery(''); else e.currentTarget.blur(); } }} />
        {settings.view === 'rooms' ? <ChannelTree {...list} onRoom={onRoom} /> : <PeopleList {...list} />}
      </div>
      {!compact && <SelfPanel onProfile={onProfile} store={store} voice={voice} assets={assets} />}
      {!compact && <div className="sb-resize" role="separator" aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={400} aria-valuenow={settings.width} tabIndex={0}
        onDoubleClick={() => update({ width: WIDTH })} onPointerDown={e => { drag.current = { x: e.clientX, width: settings.width }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={e => { if (drag.current) { const next = { ...current.current, width: clamp(drag.current.width + e.clientX - drag.current.x) }; current.current = next; setSettings(next); } }}
        onPointerUp={() => { if (drag.current) { drag.current = null; save(current.current); } }} onPointerCancel={() => { drag.current = null; save(current.current); }}
        onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); update({ width: clamp(settings.width + (e.key === 'ArrowLeft' ? -10 : 10)) }); } }} />}
    </aside>}
  </>;
});
