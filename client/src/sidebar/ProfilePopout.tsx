import type { Banner } from '../../../shared/protocol';
import { BannerEditor } from './BannerEditor';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Assets } from '../assets';
import type { Engine } from '../engine';
import type { Store } from '../net';
import { Icon, IconButton } from '../Icon';
import { Avatar } from './Avatar';
import { overlayOpen, useSurface } from './hooks';
import { bannerStyle, place, PRESENCE_COLOR } from './model';
import { PRESENCES, StatusEditor } from './SelfPanel';

export function ProfilePopout({ store, assets, engine, compact, opener, thirsty, onClose, onAppearance, onPockets, onAchievements, onLogout }: {
  store: Store; assets: Assets | null; engine: Engine | null; compact: boolean; opener: HTMLButtonElement; thirsty: boolean;
  onClose: () => void; onAppearance: () => void; onPockets: () => void; onAchievements: () => void; onLogout: () => void;
}) {
  const [editing, setEditing] = useState(false), [presenceOpen, setPresenceOpen] = useState(false);
  const [bannerEditing, setBannerEditing] = useState(false), [bannerPreview, setBannerPreview] = useState<Banner | null>(null);
  const bannerStrip = useRef<HTMLDivElement>(null);
  const closeBanner = () => { setBannerEditing(false); bannerStrip.current?.querySelector<HTMLButtonElement>('button')?.focus(); };
  const bubble = useRef<HTMLButtonElement>(null), presenceButton = useRef<HTMLButtonElement>(null);
  const surface = useSurface(store, { x: 0, y: 0 }, compact, onClose);
  useLayoutEffect(() => {
    const el = surface.ref.current;
    if (!el) return;
    el.inert = overlayOpen(store);
    if (compact) { el.style.removeProperty('top'); el.style.removeProperty('left'); el.style.removeProperty('width'); return; }
    const card = opener.closest('.sb-self')?.getBoundingClientRect();
    if (!card) return;
    el.style.width = `${card.width}px`;
    el.style.left = `${card.left}px`;
    el.style.top = `${Math.max(8, card.top - el.getBoundingClientRect().height - 8)}px`;
  });
  const me = store.users.get(store.me);
  if (!me) return null;
  const room = store.roomCallOf(me), inVoice = !!me.callId && !me.instance;
  const presence = me.presence === 'offline' ? 'online' : me.presence;
  const act = (fn: () => void) => { if (overlayOpen(store)) return; onClose(); fn(); };
  return <div {...surface} className={`sb-profile sb-surface${compact ? ' sb-surface-sheet' : ''}`} role="dialog" aria-label="Your profile"
    onKeyDown={e => {
      if (overlayOpen(store)) return;
      if (e.key === 'Escape' && bannerEditing) { e.preventDefault(); e.stopPropagation(); closeBanner(); }
      else if (e.key === 'Escape' && presenceOpen && !editing) { e.preventDefault(); e.stopPropagation(); setPresenceOpen(false); presenceButton.current?.focus(); }
      else surface.onKeyDown(e);
    }}>
    {compact && <header><button data-action className="ghost" onClick={onClose}><Icon name="arrow-left" /> Back</button></header>}
    <div ref={bannerStrip} className="sb-profile-banner" style={{ background: bannerStyle(bannerEditing ? bannerPreview : me.banner, me.look) }}>
      <IconButton data-action className="ghost sb-banner-edit" label="Edit banner" icon="edit" disabled={overlayOpen(store)}
        onClick={() => { setEditing(false); setPresenceOpen(false); setBannerPreview(me.banner ?? null); setBannerEditing(true); }} />
    </div>
    <div className="sb-surface-body sb-profile-body">
      <div className="sb-profile-identity">
        <Avatar assets={assets} user={me} size={80} />
        <button ref={bubble} data-action className={`ghost sb-profile-status${me.status ? '' : ' empty'}`} disabled={overlayOpen(store)}
          onClick={() => { setBannerEditing(false); setPresenceOpen(false); setEditing(true); }}><Icon name="message" />{me.status || '+ Set a status'}</button>
      </div>
      <div className="sb-profile-name"><strong>{me.name}</strong><small>{place(store, me)}{me.tz && ` · ${new Intl.DateTimeFormat([], { timeZone: me.tz, hour: '2-digit', minute: '2-digit' }).format(new Date(store.now()))} your time`}</small></div>
      {bannerEditing ? <BannerEditor store={store} initial={me.banner} look={me.look} onPreview={setBannerPreview} onClose={closeBanner} /> : editing ? <StatusEditor store={store} onClose={restore => { setEditing(false); if (restore) bubble.current?.focus(); }} /> : <>
        {inVoice && <section className="sb-profile-card sb-profile-voice"><strong>In voice</strong><p>{room?.name ?? `Call with ${store.names(store.callPeers(me))}`}</p>
          <button className="ghost" disabled={!engine || overlayOpen(store)} onClick={() => act(() => engine?.recenter())}>Show me on the map</button></section>}
        <div className="sb-profile-card">
          <button className="ghost sb-profile-row" onClick={() => act(() => store.openWellness('pomodoro'))}><Icon name="clock" /><span>Breaks and Pomodoro</span><Icon name="chevron-right" /></button>
          <button className="ghost sb-profile-row" onClick={() => act(onAppearance)}><Icon name="shirt" /><span>Edit look</span><Icon name="chevron-right" /></button>
          <button className="ghost sb-profile-row" onClick={() => act(onPockets)}><Icon name="backpack" /><span>Pockets</span><small>{store.items.length}</small><Icon name="chevron-right" /></button>
          <button className="ghost sb-profile-row" onClick={() => act(onAchievements)}><Icon name="trophy" /><span>Achievements{thirsty && <small>your plant needs a status today</small>}</span>{thirsty && <i className="dot sb-profile-water" />}<Icon name="chevron-right" /></button>
        </div>
        <div className="sb-profile-card">
          <button ref={presenceButton} className="ghost sb-profile-row" aria-expanded={presenceOpen} onClick={() => { if (!overlayOpen(store)) setPresenceOpen(o => !o); }}>
            <i className="dot" style={{ background: PRESENCE_COLOR[presence] }} /><span>{PRESENCES.find(p => p[0] === presence)?.[1]}</span><Icon name={presenceOpen ? 'chevron-down' : 'chevron-right'} /></button>
          {presenceOpen && <div role="group" aria-label="Presence">{PRESENCES.map(([id, label]) => <button key={id} className="ghost sb-profile-row" aria-pressed={presence === id}
            onClick={() => { if (!overlayOpen(store)) { store.setPresence(id); setPresenceOpen(false); presenceButton.current?.focus(); } }}><i className="dot" style={{ background: PRESENCE_COLOR[id] }} /><span>{label}</span></button>)}</div>}
        </div>
        <div className="sb-profile-card"><button className="ghost sb-profile-row sb-profile-logout" onClick={() => act(onLogout)}><Icon name="logout" /><span>Sign out</span></button></div>
      </>}
    </div>
  </div>;
}
