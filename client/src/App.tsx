import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadAssets, type Assets } from './assets';
import { Engine, type Pick } from './engine';
import { Voice } from './voice';
import { Soundscape } from './soundscape';
import { needsGesture, resume } from './audio';
import { prefs, savePrefs, type Category } from './prefs';
import { ITEMS, MAP, Store, type ClientUser } from './net';
import { inNativeApp, syncNative } from './native';
import { ACHIEVEMENTS, dayNumber, JUKEBOX_PER_PERSON, JUKEBOX_QUEUE_MAX, MAX_CHAT_LEN, MEET_LINK_RE, meetAs, normalizeMeetLink, kindName, PLANT_DIES_DAYS, PLANT_KINDS, PLANT_REVEAL, PLANT_STAGES, plantDead, plantName, REACTIONS, type JukeboxState, type Plant } from '../../shared/protocol';
import { GENRES, TRACK, TRACKS } from '../../shared/music';
import { FIXED_TYPES, KEEP_TYPES, objectName, RUG_COLORS, RUG_MAX, RUG_MIN, seatAt } from '../../shared/map';

// Dev server: sign in automatically as ?as=<name> (default "Dev"); each name keeps its own session,
// so several tabs can be different people.
const DEV_AS = import.meta.env.DEV ? (new URLSearchParams(location.search).get('as')?.trim() || 'Dev') : null;
const SESSION_KEY = DEV_AS ? `deck.session.dev.${DEV_AS.toLowerCase()}` : 'deck.session';
/** Phones and small windows: a thumb dock and bottom sheets (keep in step with styles.css). */
const COMPACT = '(max-width: 560px), (max-height: 500px)';
const compact = () => window.matchMedia(COMPACT).matches;

export default function App() {
  const [session, setSession] = useState(() => { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } });
  const [autoLogin, setAutoLogin] = useState(!!DEV_AS);
  const login = (s: string) => { try { localStorage.setItem(SESSION_KEY, s); } catch { /* ignore */ } setSession(s); };
  const logout = () => {
    if (session) fetch(`/api/logout?session=${encodeURIComponent(session)}`, { method: 'POST' }).catch(() => {});
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setAutoLogin(false); // after Leave, show the form instead of signing straight back in
    setSession(null);
  };
  useEffect(() => {
    if (session || !autoLogin || !DEV_AS) return;
    fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: DEV_AS, token: 'deck' }) })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => login(j.session))
      .catch(() => setAutoLogin(false));
  }, [session, autoLogin]);
  if (!session && autoLogin) return <div className="login"><p className="muted">Signing in as {DEV_AS}…</p></div>;
  if (!session) return <Login onLogin={login} />;
  const expired = () => { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } setSession(null); };
  return <Office key={session} session={session} onLogout={logout} onExpired={expired} />;
}

type Config = { netbird: boolean; tokenLogin: boolean; tokenRequired?: boolean };

function Login({ onLogin }: { onLogin: (s: string) => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [nb, setNb] = useState<{ email: string; name: string } | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState(import.meta.env.DEV ? 'deck' : '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // step 1: who does NetBird say we are? (no sign-in yet, so logging out doesn't bounce straight back in)
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(async (c: Config) => {
      setConfig(c);
      if (c.netbird) {
        const r = await fetch('/api/auth/netbird');
        if (r.ok) setNb(await r.json());
      }
    }).catch(() => setErr('Server unreachable'));
  }, []);

  const post = async (url: string, body?: unknown) => {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(j.error ?? 'login failed');
      onLogin(j.session);
    } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <div className="panel">
        <h1>The Deck</h1>
        <p className="muted">T1A virtual office</p>
        {!config && !err && <p className="muted">Knocking…</p>}
        {config?.netbird && nb && (
          <button className="netbird" autoFocus disabled={busy} onClick={() => post('/api/auth/netbird')}>
            Continue as {nb.name}<small>{nb.email}</small>
          </button>
        )}
        {config?.netbird && !nb && (
          <p className="muted">Sign-in uses NetBird. Open <b>voffice.t1a.io</b> while connected to NetBird.</p>
        )}
        {config?.tokenLogin && (
          <form onSubmit={e => { e.preventDefault(); post('/api/login', { name, token }); }} className="token-form">
            {config.netbird && <p className="or">or with the team token</p>}
            <label>Your name<input autoFocus={!nb} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ivan" /></label>
            {config.tokenRequired !== false && <label>Team token<input value={token} onChange={e => setToken(e.target.value)} type="password" /></label>}
            <button disabled={!name.trim() || busy}>Walk in</button>
          </form>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}

function Office({ session, onLogout, onExpired }: { session: string; onLogout: () => void; onExpired: () => void }) {
  const store = useMemo(() => new Store(session, onExpired), [session]);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [assets, setAssets] = useState<Assets | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [showRooms, setShowRooms] = useState(() => window.innerWidth > 900);
  const [showMeet, setShowMeet] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [personMenu, setPersonMenu] = useState<PersonMenuAt | null>(null);
  const openPerson = (at: PersonMenuAt) => { setPick(null); setPersonMenu(at); };
  const [showAppearance, setShowAppearance] = useState(false);
  const [, tick] = useState(0);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => { store.connect(); return () => store.close(); }, [store]);
  useEffect(() => { const s = new Soundscape(store); return () => s.destroy(); }, [store]);
  // Receive connections start before microphone permission settles.
  const [voice, setVoice] = useState<Voice | null>(null);
  useEffect(() => syncNative(store), [store]);
  useEffect(() => {
    let v: Voice | null = null, unsub = () => {}, cancelled = false;
    fetch('/api/config').then(r => r.json()).then(c => {
      if (cancelled) return;
      v = new Voice(store, c.iceServers ?? []);
      unsub = store.subscribe(() => v!.sync());
      v.sync(); setVoice(v);
      if (import.meta.env.DEV) Object.assign(window, { __voice: v });
    }).catch(() => {});
    return () => { cancelled = true; unsub(); v?.destroy(); };
  }, [store]);
  useEffect(() => { loadAssets().then(setAssets); }, []);
  useEffect(() => {
    if (!assets || !canvasRef.current) return;
    const e = new Engine(canvasRef.current, store, assets);
    e.onPick = p => {
      // a wall calendar opens your calendar right away (nothing to walk over for)
      const use = p?.kind === 'object' ? MAP.objects.find(o => o.id === p.id)?.use : undefined;
      if (use?.kind === 'jukebox' && p) { setPick(null); return store.openJukebox(p.id); }
      if (use?.kind === 'calendar') { setPick(null); return store.openCalendar(); }
      if (use?.kind === 'meetings') { setPick(null); return store.openMeetings(); }
      if (use?.kind === 'achievements') { setPick(null); return store.openAchievements(); }
      if (use?.kind === 'link') { setPick(null); return store.openLink(use); } // a panel, like the calendar: its link is a real tap
      setPick(cur => (p && cur?.kind === p.kind && cur.id === p.id ? null : p)); // same target again: close
    };
    e.onZoom = () => tick(n => n + 1);
    e.onEditChange = () => tick(n => n + 1);
    engineRef.current = e; setEngine(e);
    if (import.meta.env.DEV) Object.assign(window, { __deck: { store, engine: e } });
    return () => { e.destroy(); setEngine(null); };
  }, [assets, store]);
  useEffect(() => { const i = setInterval(() => { tick(n => n + 1); store.checkAgenda(); }, 1000); return () => clearInterval(i); }, [store]);
  useEffect(() => { if (engineRef.current) engineRef.current.selected = pick; }, [pick]);
  useEffect(() => { engine?.setEditing(editing && store.admin); }, [engine, editing, store.admin]);

  const me = store.users.get(store.me);
  const myRoom = me ? store.roomOf(me) : undefined;
  useEffect(() => { if (me && !me.lookSet) setShowAppearance(true); }, [me?.id, me?.lookSet]);

  return (
    <div className="office">
      <TopBar store={store} roomName={myRoom?.name} onToggleRooms={() => setShowRooms(s => !s)} onLogout={onLogout}
        onToggleMeet={() => setShowMeet(s => !s)} onToggleAppearance={() => setShowAppearance(s => me?.lookSet ? !s : true)} engine={engine}
        editing={editing} onToggleEdit={() => setEditing(e => !e)} />
      <div className="stage">
        <div className="canvas-wrap"><canvas ref={canvasRef} /></div>
        {!assets && <div className="loading">Unlocking the door…</div>}
        {!store.connected && assets && <div className="loading small">Reconnecting…</div>}
        {showRooms && <RoomList store={store} onPerson={openPerson} onClose={() => setShowRooms(false)}
          onPick={id => { engineRef.current?.walkToUser(id); if (compact()) setShowRooms(false); }}
          onRoom={id => { engineRef.current?.walkToRoom(id); if (compact()) setShowRooms(false); }} />}
        {editing && store.admin && engine && <EditPanel store={store} engine={engine} assets={assets} onDone={() => setEditing(false)} />}
        {store.calendarOpen && <CalendarPanel store={store} />}
        {store.meetingsOpen && <MeetingsPanel store={store} />}
        {store.jukeboxOpen && <JukeboxPanel key={store.jukeboxOpen} store={store} id={store.jukeboxOpen} />}
        {store.linkOpen && <LinkPanel store={store} />}
        {store.achievementsOpen && me && <AchievementsPanel store={store} me={me} assets={assets} />}
        {(showMeet || store.pendingKnock) && <MeetSetup key={store.pendingKnock ?? 'panel'} store={store} onClose={() => setShowMeet(false)} />}
        {showAppearance && me && <AppearanceMenu key={me.id} look={me.look} assets={assets} firstTime={!me.lookSet}
          onSave={(look) => { store.setLook(look); setShowAppearance(false); }} onClose={() => setShowAppearance(false)} />}
        <div className="chips">
          <MeetingChip store={store} />
          <NowPlayingChip store={store} />
          {me?.callId && !store.roomCallOf(me) && store.voiceOwner && <CallChip store={store} voice={voice} />}
          <DeskChip store={store} />
        </div>
        <Toasts store={store} />
        {pick && engineRef.current && <ActionWheel key={`${pick.kind}:${pick.id}`} store={store} engine={engineRef.current} pick={pick} onPerson={openPerson} onClose={() => setPick(null)} />}
        <div className="self-stack">
          {store.chatWith && <ChatPanel key={store.chatWith} store={store} withId={store.chatWith} />}
          <SelfPanel store={store} voice={voice} />
        </div>
        {personMenu && <PersonMenu key={personMenu.id} store={store} at={personMenu} onClose={() => setPersonMenu(null)} />}
        <Dock store={store} engine={engine} roomsOpen={showRooms} onRooms={() => setShowRooms(s => !s)} />
      </div>
    </div>
  );
}

function TopBar({ store, roomName, onToggleRooms, onToggleMeet, onToggleAppearance, onLogout, engine, editing, onToggleEdit }: {
  store: Store; roomName?: string; onToggleRooms: () => void; onToggleMeet: () => void; onToggleAppearance: () => void; onLogout: () => void; engine: Engine | null;
  editing: boolean; onToggleEdit: () => void;
}) {
  const me = store.users.get(store.me);
  const [draft, setDraft] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => { // the ⋯ menu closes on a tap anywhere else
    if (!more) return;
    const off = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.topbar')) setMore(false); };
    window.addEventListener('pointerdown', off);
    return () => window.removeEventListener('pointerdown', off);
  }, [more]);
  const z = engine?.zoom;
  const status = draft ?? me?.status ?? '';
  return (
    <header className="topbar">
      <span className="brand">The Deck</span>
      <span className="where">{roomName ? `in ${roomName}` : me ? 'in the hallway' : ''}</span>
      <select value={me?.presence === 'offline' ? 'online' : me?.presence ?? 'online'}
        onChange={e => store.setPresence(e.target.value as 'online' | 'away' | 'in_call')} aria-label="Presence">
        <option value="online">● Online</option>
        <option value="away">◐ Away</option>
        <option value="in_call">🎧 In a call</option>
      </select>
      <form className="status" onSubmit={e => { e.preventDefault(); store.setStatus(status); setDraft(null); (document.activeElement as HTMLElement)?.blur(); }}>
        <input value={status} maxLength={80} placeholder="What are you on? (waters your plant)" onChange={e => setDraft(e.target.value)}
          onBlur={() => { if (draft !== null) { store.setStatus(draft); setDraft(null); } }} />
      </form>
      <div className="zoom">
        <button onClick={() => engine?.zoomOut()} disabled={!z?.canOut} title="Zoom out (−, ⌘ scroll or pinch)" aria-label="Zoom out">−</button>
        <button onClick={() => engine?.zoomIn()} disabled={!z?.canIn} title="Zoom in (+, ⌘ scroll or pinch)" aria-label="Zoom in">+</button>
        <button onClick={() => engine?.toggleOverview()} className={z?.overview ? 'on' : ''} aria-pressed={!!z?.overview}
          title={z?.overview ? 'Back to where you were (M)' : 'Whole floor (M)'}>⤢</button>
      </div>
      <UnreadButton store={store} />
      <button className="ghost more-btn" aria-label="More" aria-expanded={more} onClick={() => setMore(m => !m)}>⋯</button>
      <div className={`top-more${more ? ' open' : ''}`} onClick={e => { if (!(e.target as HTMLElement).closest('.mac-app')) setMore(false); }}>
        <button onClick={onToggleMeet} className={`meet-btn${store.meetLink === '' && !store.google ? ' unset' : ''}`}
          title={store.google ? `Google connected: ${store.google}` : store.meetLink ? `Your Meet room: ${store.meetLink}` : 'Set up Google Meet'}>Meet</button>
        <MacAppButton />
        <button onClick={onToggleRooms} title="Who's where: click a room or a person to walk there" className="rooms-btn">People</button>
        <button onClick={onLogout} title="Sign out" className="ghost">Leave</button>
      </div>
      <button onClick={() => store.openAchievements(!store.achievementsOpen)} className="hanger-btn trophy-btn"
        title={me?.plant && needsWater(me.plant, store.now()) ? 'Achievements · your plant needs a status today' : 'Achievements and your plant'} aria-label="Achievements and your plant">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8 20h8M9 17h6" /></svg>
        {me?.plant && needsWater(me.plant, store.now()) && <b className="dot" />}
      </button>
      {store.admin && <button onClick={onToggleEdit} className={`hanger-btn${editing ? ' on' : ''}`} aria-pressed={editing}
        title={editing ? 'Done rearranging' : 'Rearrange the office (admins)'} aria-label="Rearrange the office">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4" /></svg>
      </button>}
      <button onClick={onToggleAppearance} className="hanger-btn" title="Character appearance" aria-label="Character appearance">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a2 2 0 0 0-2 2c0 1 .7 1.6 1.6 2.4.6.5 1.1 1 1.1 1.8V11M12 9l-7 9h14l-7-9ZM3 21h18" /></svg>
      </button>
    </header>
  );
}

const LOOK_COLORS = {
  skin: ['#f8dcc0', '#f2c79b', '#e2ad7f', '#c98d5e', '#a46a43', '#7c4f32'],
  hair: ['#2b1d1f', '#4f2b1a', '#6b3e26', '#a0603a', '#d8a050', '#ecd59a', '#b4473a', '#8c8a98', '#3e5a8a', '#c8789a'],
  eyes: ['#2b1d1f', '#4b2e1e', '#3e5a8a', '#4f7d45', '#6b9ac4', '#7a4c32'],
  shirt: ['#4a7ab0', '#b4534a', '#7a9a55', '#d0a040', '#8a5aa0', '#4f9a92', '#d8805a', '#e8e0d0', '#5a5a6e', '#c8607a', '#6a8ad0', '#9a7a50'],
  pants: ['#3d3a52', '#2c3e5a', '#5a4030', '#4a4a4a', '#6a5a7a', '#3a5a4a'],
  shoes: ['#4a3028', '#282832', '#68432e', '#85766b', '#b05b42', '#d0b58a'],
  glassesColor: ['#282832', '#4a3028', '#d0b58a', '#85766b', '#3e5a8a', '#b4473a', '#e8e0d0'],
  hatColor: ['#3e5a8a', '#b4534a', '#3a5a4a', '#282832', '#d0a040', '#e8e0d0', '#6b3e26'],
};

function AppearanceMenu({ look, assets, firstTime, onSave, onClose }: {
  look: PublicLook; assets: Assets | null; firstTime: boolean; onSave: (look: PublicLook) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(look);
  const [tab, setTab] = useState<'body' | 'clothes'>('body');
  const previewRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !assets) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const frame = assets.atlas.character;
    canvas.width = frame.frameW; canvas.height = frame.frameH;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(assets.sheet(draft), 0, 0, frame.frameW, frame.frameH, 0, 0, frame.frameW, frame.frameH);
  }, [assets, draft]);
  const set = <K extends keyof PublicLook>(key: K, value: PublicLook[K]) => setDraft(d => ({ ...d, [key]: value }));
  const colors = (label: string, key: 'skin' | 'hair' | 'eyes' | 'shirt' | 'pants' | 'shoes' | 'glassesColor' | 'hatColor') => (
    <fieldset className="look-colors"><legend>{label}</legend><div className="swatches">
      {LOOK_COLORS[key].map(color => <button key={color} type="button" className={`swatch${draft[key] === color ? ' selected' : ''}`}
        style={{ backgroundColor: color }} title={color} aria-label={`${label} ${color}`} aria-pressed={draft[key] === color} onClick={() => set(key, color)} />)}
    </div></fieldset>
  );
  const select = (label: string, value: number, options: string[], key: 'style' | 'top' | 'bottom' | 'glasses' | 'hat') => (
    <label className="look-select">{label}<select value={value} onChange={e => set(key, Number(e.target.value))}>
      {options.map((option, i) => <option value={i} key={option}>{option}</option>)}
    </select></label>
  );
  const styles = (assets?.atlas.character.styles ?? ['short', 'long', 'ponytail']).map(s => s[0].toUpperCase() + s.slice(1));
  const tops = assets?.atlas.character.tops ?? ['T-shirt', 'Button-up shirt', 'Sweater'];
  const bottoms = assets?.atlas.character.bottoms ?? ['Trousers', 'Skirt', 'Shorts'];
  return (
    <div className="appearance-backdrop" onClick={e => { if (e.target === e.currentTarget && !firstTime) onClose(); }}>
      <section className="appearance-panel" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
        <header className="appearance-head"><div><h2 id="appearance-title">Your character</h2><p>{firstTime ? 'Choose your look before stepping into the office.' : 'Make the office feel a little more like you.'}</p></div>
          {!firstTime && <button className="ghost" onClick={onClose} aria-label="Close appearance settings">×</button>}</header>
        <div className="appearance-preview"><div className="avatar-frame"><canvas ref={previewRef} /></div><span>{styles[draft.style]} hair</span></div>
        <nav className="appearance-tabs" aria-label="Appearance categories">
          <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>Body</button>
          <button className={tab === 'clothes' ? 'active' : ''} onClick={() => setTab('clothes')}>Clothes</button>
        </nav>
        <div className="appearance-options">
          {tab === 'body' ? <>
            {select('Hairstyle', draft.style, styles, 'style')}
            {colors('Hair color', 'hair')}{colors('Skin tone', 'skin')}{colors('Eye color', 'eyes')}
          </> : <>
            {select('Top', draft.top, tops, 'top')}{colors('Top color', 'shirt')}
            {select('Bottom', draft.bottom, bottoms, 'bottom')}{colors('Bottom color', 'pants')}
            {colors('Shoe color', 'shoes')}
          </>}
        </div>
        <footer className="appearance-actions">
          {!firstTime && <button className="ghost" onClick={onClose}>Cancel</button>}
          <button onClick={() => onSave(draft)}>{firstTime ? 'Save & enter office' : 'Save changes'}</button>
        </footer>
      </section>
    </div>
  );
}

type PublicLook = import('../../shared/protocol').Look;

const PRESENCE_COLOR: Record<string, string> = { online: '#7cc87c', away: '#e0b050', in_call: '#d86a5a', offline: '#666' };

type PersonMenuAt = { id: string; x: number; y: number };

function RoomList({ store, onPick, onRoom, onPerson, onClose }: {
  store: Store; onPick: (id: string) => void; onRoom: (id: string) => void; onPerson: (at: PersonMenuAt) => void; onClose: () => void;
}) {
  const menu = (u: ClientUser, e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); if (u.id !== store.me) onPerson({ id: u.id, x: e.clientX, y: e.clientY }); };
  const more = (u: ClientUser) => u.id !== store.me && <button className="ghost person-more" aria-label={`Actions for ${u.name}`} aria-haspopup="dialog"
    onClick={e => { const r = e.currentTarget.getBoundingClientRect(); e.stopPropagation(); onPerson({ id: u.id, x: r.left, y: r.bottom }); }}>⋯</button>;
  const byRoom = new Map<string, string[]>();
  for (const u of store.users.values()) {
    if (u.presence === 'offline') continue;
    const r = u.instance ? 'meetings' : store.roomOf(u)?.id ?? 'hall'; // in a meeting's own room, not the real one
    byRoom.set(r, [...(byRoom.get(r) ?? []), u.id]);
  }
  const offline = [...store.users.values()].filter(u => u.presence === 'offline');
  return (
    <aside className="rooms">
      <div className="rooms-head"><span>People</span><button className="ghost" onClick={onClose}>×</button></div>
      {[...MAP.rooms, { id: 'meetings', name: 'In meetings', rules: { label: 'calendar meetings' }, capacity: 0 } as const,
        { id: 'hall', name: 'Hallway', rules: { label: 'passing through' }, capacity: 0 } as const].map(r => {
        const ids = byRoom.get(r.id) ?? [];
        const jukebox = MAP.objects.find(o => o.use?.kind === 'jukebox' && store.jukeboxRoom(o.id)?.id === r.id);
        const state = jukebox && store.jukebox[jukebox.id];
        const subtitle = state && r.rules.label ? r.rules.label.replace(/^jukebox/, state.pausedAt !== null ? 'paused' : `♪ ${TRACK.get(state.track)?.title ?? state.track}`) : r.rules.label;
        if ((r.id === 'hall' || r.id === 'meetings') && !ids.length) return null;
        return (
          <section key={r.id}>
            <h3 onClick={MAP.rooms.some(m => m.id === r.id) ? () => onRoom(r.id) : undefined} title={MAP.rooms.some(m => m.id === r.id) ? `Walk to ${r.name}` : undefined}>{r.name} <small>{ids.length}{r.capacity ? `/${r.capacity}` : ''} · {subtitle}</small></h3>
            <ul>
              {ids.map(id => {
                const u = store.users.get(id)!;
                return (
                  <li key={id} onContextMenu={e => menu(u, e)} title={u.status || undefined}>
                    <i style={{ background: PRESENCE_COLOR[u.presence] }} />
                    <button className={`ghost person-name${id === store.me ? ' me' : ''}`} onClick={() => onPick(id)} title={id === store.me ? 'Show me' : `Walk to ${u.name}`}>{u.name}{store.roomCallOf(u) ? ` 🎙${userIcons(u)}` : ''}</button>
                    {more(u)}
                    {!!store.unread.get(id) && <b className="unread" title="Unread messages" onClick={e => { e.stopPropagation(); store.openChat(id); }}>💬 {store.unread.get(id)}</b>}
                    {u.door ? <em>{{ arriving: 'just arrived', thinking: 'packing up…', leaving: 'heading out' }[u.door]}</em>
                      : u.meeting ? <em>in a meeting until {store.clock(u.meeting)}</em> : u.status && <em>{u.status}</em>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {offline.length > 0 && <section><h3>Offline <small>{offline.length}</small></h3><ul>{offline.map(u => <li key={u.id} className="off" onContextMenu={e => menu(u, e)}><i style={{ background: PRESENCE_COLOR.offline }} /><span>{u.name}</span>{more(u)}</li>)}</ul></section>}
    </aside>
  );
}

/** Meet room setup: from the Meet button, or as a guided step the first time you knock without one. */
function MeetSetup({ store, onClose }: { store: Store; onClose: () => void }) {
  const knockTo = store.pendingKnock ? store.users.get(store.pendingKnock) : undefined;
  const [value, setValue] = useState(store.meetLink ?? '');
  const parsed = value.trim() ? normalizeMeetLink(value) : '';
  const done = (action: 'saved' | 'skip' | 'cancel') => { if (knockTo) store.finishKnockSetup(action); onClose(); };
  const save = (link: string) => { store.setMeetLink(link); done('saved'); };
  const pasteFromClipboard = async () => { try { setValue(await navigator.clipboard.readText()); } catch { /* not allowed: user pastes by hand */ } };
  const google = store.google;
  useEffect(() => { if (google === null) store.prepareGoogle(); }, [store, google]);
  return (
    <div className={knockTo ? 'modal-backdrop' : ''} onClick={e => { if (knockTo && e.target === e.currentTarget) done('cancel'); }}>
      <form className={`meet-panel${knockTo ? ' guided' : ''}`} onSubmit={e => { e.preventDefault(); if (parsed) save(parsed); }}>
        <div className="rooms-head">
          <span>{knockTo ? `Before you knock on ${knockTo.name.split(' ')[0]}…` : google ? 'Google Meet' : 'Your Google Meet room'}</span>
          <button type="button" className="ghost" onClick={() => done('cancel')}>×</button>
        </div>
        {google !== undefined && <div className="google-row">
          {google
            ? <><span>Google: <b>{google}</b>. Calls you start get their own Meet room.</span>
                <button type="button" className="ghost" onClick={() => store.disconnectGoogle()}>Disconnect</button></>
            : <><span>Connect Google and every call you start gets its own Meet room. Anyone at T1A joins without asking.</span>
                {store.googleAuthUrl
                  ? <ExternalLink href={store.googleAuthUrl} onOpen={() => store.prepareGoogle()}>Connect Google</ExternalLink>
                  : <span className="muted small">…</span>}</>}
        </div>}
        {/* with Google connected every call gets its own room, so there's nothing to set up by hand */}
        {!google && <>
        {google !== undefined && <p className="muted small">Or use your own reusable room:</p>}
        <p className="muted">
          {knockTo ? 'Set up your own Meet room once. When someone accepts your knock, you both join it — no more two separate calls.'
            : 'When you knock and they accept, you both join this room.'}
        </p>
        <ol className="steps">
          <li>Open <ExternalLink href={meetAs('https://meet.google.com/', store.meetAccount)}>meet.google.com</ExternalLink> (opens a new tab)
            {store.meetAccount && <> as <b>{store.meetAccount}</b></>}</li>
          <li>Click <b>New meeting</b> → <b>Create a meeting for later</b></li>
          <li>Copy the link and paste it here — it's yours to reuse</li>
        </ol>
        <div className="paste-row">
          <input autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" />
          <button type="button" className="ghost" onClick={pasteFromClipboard} title="Paste from clipboard">Paste</button>
        </div>
        {parsed === null && <p className="err">That doesn't look like a Meet room link (abc-defg-hij).</p>}
        <div className="row">
          {knockTo && <button type="button" className="ghost" onClick={() => done('skip')}>Knock without a room</button>}
          {!knockTo && store.meetLink && <button type="button" className="ghost" onClick={() => save('')}>Clear</button>}
          <button disabled={!parsed || parsed === store.meetLink}>{knockTo ? `Save & knock` : 'Save'}</button>
        </div>
        </>}
      </form>
    </div>
  );
}

/** Opens a Google page (Calendar, an event) as my account, like meetAs does for Meet. */
const asAccount = (link: string, email: string | null) => {
  if (!email) return link;
  try { const u = new URL(link); if (/(^|\.)google\.com$/.test(u.hostname)) u.searchParams.set('authuser', email); return u.toString(); }
  catch { return link; }
};
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** All-day events come as YYYY-MM-DD: that's a local date, not UTC midnight. */
const parseWhen = (s: string, allDay: boolean) => (allDay ? new Date(`${s}T00:00:00`) : new Date(s));
const hm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** In a meeting's own room: what it is, its call link, and the way back. */
function MeetingChip({ store }: { store: Store }) {
  const me = store.users.get(store.me);
  if (!me) return null;
  if (!me.instance) { // out of the room but still in the meeting: rejoin, or leave it for good
    const a = me.meeting ? store.myBusyMeeting : null;
    if (!a) return null;
    return <div className="desk-chip call-chip meeting-chip">
      <span>📅 <b>{a.title}</b> <small>· in the meeting until {store.clock(a.end)} · knocks go to Later</small></span>
      <button onClick={() => store.goToMeeting(a.key)}>Rejoin</button>
      <button className="end" title="You're no longer busy: knocks come through again" onClick={() => store.leaveMeetingForGood(a.key)}>Leave meeting</button>
    </div>;
  }
  const m = store.myMeeting, room = store.meetingRooms.find(r => r.id === me.instance);
  const others = (room?.members ?? []).filter(id => id !== me.id).map(id => store.users.get(id)).filter((u): u is ClientUser => !!u);
  return <div className="desk-chip call-chip meeting-chip">
    <span>📅 <b>{m?.title ?? 'Meeting'}</b> <small>· until {store.clock(room?.until ?? m?.end ?? 0)}{others.length ? ` · with ${store.names(others)}` : ' · waiting for the others'}</small></span>
    {m?.link && <ExternalLink href={meetAs(m.link, store.meetAccount)}>Join call</ExternalLink>}
    <button className="end" onClick={() => store.leaveMeeting()}>Leave</button>
  </div>;
}

const musicTime = (ms: number) => { const s = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const musicPosition = (store: Store, state: JukeboxState) => Math.max(0, Math.min(TRACK.get(state.track)?.duration ?? 0, state.pausedAt ?? store.now() - state.startedAt));

function JukeboxControls({ store, id, state, disabled }: { store: Store; id: string; state: JukeboxState; disabled: boolean }) {
  const paused = state.pausedAt !== null;
  return <>
    <button aria-label={paused ? 'Play' : 'Pause'} disabled={disabled}
      onClick={() => store.jukeboxAction(id, { action: paused ? 'play' : 'pause', playId: state.playId })}>{paused ? '▶' : '⏸'}</button>
    <button aria-label="Skip" disabled={disabled} onClick={() => store.jukeboxAction(id, { action: 'skip', playId: state.playId })}>⏭</button>
  </>;
}

function NowPlayingChip({ store }: { store: Store }) {
  const o = MAP.objects.find(o => o.use?.kind === 'jukebox' && store.inJukeboxRoom(o.id));
  const state = o && store.jukebox[o.id], track = state && TRACK.get(state.track);
  if (!o || !state || !track) return null;
  const label = `♪ ${track.title} — ${track.artist} · ${musicTime(musicPosition(store, state))} / ${musicTime(track.duration)}`;
  return <div className="desk-chip jukebox-chip" onClick={() => store.openJukebox(o.id)}>
    <button className="ghost jukebox-chip-title" title={label} onClick={e => { e.stopPropagation(); store.openJukebox(o.id); }}>{label}</button>
    <div className="jukebox-controls" onClick={e => e.stopPropagation()}>
      <JukeboxControls store={store} id={o.id} state={state} disabled={!store.connected} />
    </div>
    <button className="ghost" onClick={e => { e.stopPropagation(); store.openJukebox(o.id); }}>Queue · {state.queue.length}</button>
  </div>;
}

function JukeboxPanel({ store, id }: { store: Store; id: string }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);
  const state = store.jukebox[id], track = state && TRACK.get(state.track), room = store.jukeboxRoom(id);
  const known = store.connected && !!state, inside = store.inJukeboxRoom(id), disabled = !known || !inside;
  const position = state ? musicPosition(store, state) : 0;
  const mine = state?.queue.filter(e => e.by === store.me).length ?? 0;
  const last = state?.last && store.now() - state.last.at < 10_000 ? state.last : null;
  const close = () => store.closeJukebox();
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key !== 'Tab') return;
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? [])];
    const first = controls[0], end = controls[controls.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); end?.focus(); }
    else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); first?.focus(); }
  };
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Jukebox" onKeyDown={onKey} className="meet-panel guided calendar-panel jukebox-panel">
      <div className="rooms-head"><span>🎵 Jukebox</span><button className="ghost" aria-label="Close jukebox" onClick={close}>×</button></div>
      {!known && <p role="status">Reconnecting…</p>}
      {!inside && <div className="jukebox-walk"><span>Walk into {room?.name ?? 'the room'} to pick music</span><button disabled={!known} onClick={() => store.walkToJukebox(id)}>Walk over</button></div>}
      <section>
        <h3>Now playing</h3>
        {state && track && <>
          <b>{track.title}</b><p className="small">{track.artist} · {track.genre}</p>
          <progress className="jukebox-progress" aria-label="Track progress" max={track.duration} value={position} />
          <div className="jukebox-times"><span>{musicTime(position)}</span><span>{musicTime(track.duration)}</span></div>
          <p className="small">{state.by ? `picked by ${store.name(state.by)}` : 'shuffle'}</p>
          {last && <p className="small" role="status">{{ pause: 'Paused', play: 'Resumed', skip: 'Skipped' }[last.kind]} by {store.name(last.by)}</p>}
          <div className="jukebox-controls"><JukeboxControls store={store} id={id} state={state} disabled={disabled} /></div>
        </>}
      </section>
      <section>
        <h3>Up next</h3>
        {!state?.queue.length && <p className="small">Nothing queued — shuffling the library</p>}
        <ol className="jukebox-tracks">
          {state?.queue.map(e => { const t = TRACK.get(e.track); return t && <li key={e.id}>
            <div><b>{t.title}</b><small>{t.artist} · picked by {store.name(e.by)}</small></div>
            {e.by === store.me && <button className="ghost" disabled={disabled} aria-label={`Remove ${t.title} from queue`} onClick={() => store.jukeboxAction(id, { action: 'unqueue', entry: e.id })}>×</button>}
          </li>; })}
        </ol>
      </section>
      <section>
        <h3>Library</h3>
        {GENRES.map(genre => <div className="jukebox-genre" key={genre}>
          <h4>{genre}</h4><ul className="jukebox-tracks">
            {TRACKS.filter(t => t.genre === genre).map(t => {
              const reason = state?.track === t.id ? 'Playing now' : state?.queue.some(e => e.track === t.id) ? 'Already queued'
                : mine >= JUKEBOX_PER_PERSON ? 'You have 3 tracks queued' : (state?.queue.length ?? 0) >= JUKEBOX_QUEUE_MAX ? 'The queue is full' : undefined;
              return <li key={t.id}>
                <div><b>{t.title}</b><small>{t.artist} · {musicTime(t.duration)} · <ExternalLink href={t.page}>CC0</ExternalLink></small></div>
                <span title={reason}><button disabled={disabled || !!reason} title={reason} aria-label={`Queue ${t.title}`} onClick={() => store.jukeboxAction(id, { action: 'queue', track: t.id })}>+</button></span>
              </li>;
            })}
          </ul>
        </div>)}
      </section>
    </div>
  </div>;
}

/** Today's status hasn't been set yet (or the plant is gone): the plant wants attention. */
const needsWater = (p: Plant, now: number) => plantDead(p, now) || p.care < dayNumber(now);

/** Office admins: what to add, and what to do with the selected thing. The floor itself is where you drag. */
function EditPanel({ store, engine, assets, onDone }: { store: Store; engine: Engine; assets: Assets | null; onDone: () => void }) {
  const sel = engine.editSel ? engine.item(engine.editSel) : undefined;
  const types = Object.keys(MAP.catalog).filter(t => !KEEP_TYPES.has(t) && !FIXED_TYPES.has(t));
  const resize = (dw: number, dh: number) => sel && store.edit({ op: 'rug', id: sel.id, w: sel.w + dw, h: sel.h + dh });
  return (
    <div className="edit-panel">
      <div className="rooms-head"><span>Rearrange the office</span><button onClick={onDone}>Done</button></div>
      <p className="hint">Drag furniture or rugs to move them. Arrows nudge, Delete removes, Esc lets go. Everyone sees changes right away.</p>
      {sel && <section className="edit-sel">
        <h3>{sel.type ? objectName(sel.type) : 'Rug'}</h3>
        {sel.color && <>
          <div className="swatches">{RUG_COLORS.map(c => <button key={c} className={`swatch rug-${c}${sel.color === c ? ' on' : ''}`} title={c} aria-label={`${c} rug`}
            onClick={() => store.edit({ op: 'rug', id: sel.id, color: c })} />)}</div>
          <div className="rug-size">
            <span>{sel.w} × {sel.h}</span>
            <button onClick={() => resize(-1, 0)} disabled={sel.w <= RUG_MIN} title="Narrower">↔−</button>
            <button onClick={() => resize(1, 0)} disabled={sel.w >= RUG_MAX} title="Wider (shift →)">↔+</button>
            <button onClick={() => resize(0, -1)} disabled={sel.h <= RUG_MIN} title="Shorter">↕−</button>
            <button onClick={() => resize(0, 1)} disabled={sel.h >= RUG_MAX} title="Longer (shift ↓)">↕+</button>
          </div>
        </>}
        {sel.type && FIXED_TYPES.has(sel.type) ? <p className="hint">This one stays where it is.</p>
          : sel.type && KEEP_TYPES.has(sel.type) ? <p className="hint">The office needs this one: move it, but it stays.</p>
          : <button className="danger" onClick={() => store.edit({ op: 'remove', id: sel.id })}>Remove</button>}
      </section>}
      <h3>Add <small>{engine.placing ? 'click the floor to place · Esc to stop' : 'pick one, then click the floor'}</small></h3>
      <div className="palette">
        <button className={engine.placing === 'rug' ? 'on' : ''} onClick={() => engine.setPlacing(engine.placing === 'rug' ? null : 'rug')} title="rug">
          <ItemThumb assets={assets} frame="rug_green_c" /><span>rug</span>
        </button>
        {types.map(t => <button key={t} className={engine.placing === t ? 'on' : ''} onClick={() => engine.setPlacing(engine.placing === t ? null : t)} title={objectName(t)}>
          <ItemThumb assets={assets} frame={t} /><span>{objectName(t)}</span>
        </button>)}
      </div>
      <button className="ghost reset" onClick={() => { if (confirm('Put every piece of furniture and every rug back where it started? Everyone sees it at once.')) store.resetLayout(); }}>
        Reset to the original layout…</button>
    </div>
  );
}

/** A world-atlas frame, scaled to fit a 32×32 box, crisp. */
function ItemThumb({ assets, frame }: { assets: Assets | null; frame: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current, f = assets?.atlas.frames[frame]; if (!c || !f || !assets) return;
    const k = Math.max(1, Math.floor(32 / Math.max(f.w, f.h))), w = Math.min(32, f.w * k), h = Math.min(32, f.h * k);
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(assets.world, f.x, f.y, f.w, f.h, (32 - w) / 2, 32 - h, w, h);
  }, [assets, frame]);
  return <canvas ref={ref} width={32} height={32} />;
}

/** A plant sprite from the world atlas, scaled up crisply. */
function PlantSprite({ assets, plant, now, scale = 4 }: { assets: Assets | null; plant: Plant; now: number; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const name = plantDead(plant, now) ? 'pot_dead' : plant.kind && plant.stage >= PLANT_REVEAL ? `pot_${plant.kind}_${plant.stage}` : `pot_${plant.stage}`;
  useEffect(() => {
    const c = ref.current, f = assets?.atlas.frames[name]; if (!c || !f || !assets) return;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(assets.world, f.x, f.y, f.w, f.h, 0, 0, f.w * scale, f.h * scale);
  }, [assets, name, scale]);
  return <canvas ref={ref} width={12 * scale} height={20 * scale} className="plant-sprite" />;
}

/** The Lobby notice board (and the 🏆 button): how your plant is doing, what makes it grow, and your achievements. */
function AchievementsPanel({ store, me, assets }: { store: Store; me: ClientUser; assets: Assets | null }) {
  const now = store.now(), today = dayNumber(now), p = me.plant, close = () => store.openAchievements(false);
  const dead = p && plantDead(p, now), left = p ? PLANT_DIES_DAYS - (today - p.care) : 0;
  const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="meet-panel guided calendar-panel achievements">
        <div className="rooms-head"><span>🏆 Achievements</span><button type="button" className="ghost" aria-label="Close" onClick={close}>×</button></div>
        <section className="plant-card">
          {p && <PlantSprite assets={assets} plant={p} now={now} />}
          <div>
            <b>{!p ? 'No plant yet' : dead ? 'Your plant withered' : `Your ${plantName(p)}`}</b>
            {p && !dead && <>
              <div className="pips" aria-label={`Stage ${p.stage + 1} of ${PLANT_STAGES.length}`}>{PLANT_STAGES.map((_, i) => <i key={i} className={i <= p.stage ? 'on' : ''} />)}</div>
              <small>{PLANT_STAGES[p.stage]}{p.stage < PLANT_REVEAL ? ' · what it becomes shows at stage 4' : ''}</small>
            </>}
            <p className={p && !dead && p.care >= today ? 'ok' : 'todo'}>
              {!p ? 'Set a status to plant one.'
                : dead ? `A week passed without a status. Set one to plant a new seedling.`
                : p.care >= today ? '✓ Watered today: it grows again tomorrow when you set a status.'
                : `💧 Set a status today to water it. It withers in ${left} day${left === 1 ? '' : 's'} without one.`}
            </p>
            <small className="muted-line">Your plant grows one stage each day you set a status, in the box at the top. It stands on your home desk, or in the Orangery if you don't have one.</small>
          </div>
        </section>
        <ul className="achievement-list">
          {ACHIEVEMENTS.map(a => {
            const got = me.achievements[a.id];
            const progress = a.id === 'botanist' && !got ? `${Math.min(me.bloomed.length, a.goal!)}/${a.goal}` : null;
            return <li key={a.id} className={got ? 'got' : a.soon ? 'soon' : ''}>
              <span className="icon">{a.icon}</span>
              <span><b>{a.title}</b><br /><small>{a.how}</small>
                {a.id === 'botanist' && me.bloomed.length > 0 && <><br /><small className="muted-line">Bloomed: {me.bloomed.map(kindName).join(', ')} · {PLANT_KINDS.length} kinds in all</small></>}</span>
              <small className="state">{got ? `✓ ${when(got)}` : a.soon ? 'Coming soon' : progress ?? ''}</small>
            </li>;
          })}
        </ul>
      </div>
    </div>
  );
}

/** The board by the Meeting room: meetings on right now in their own rooms. Titles only for their attendees. */
function MeetingsPanel({ store }: { store: Store }) {
  const me = store.users.get(store.me);
  const mine = new Map(store.agenda.map(a => [a.instance, a]));
  const now = store.now();
  const goable = store.agenda.filter(a => a.start - 10 * 60_000 <= now && a.end > now && a.instance !== me?.instance && !store.meetingRooms.some(r => r.id === a.instance));
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) store.closeMeetings(); }}>
      <div className="meet-panel guided calendar-panel">
        <div className="rooms-head"><span>🚪 Meetings on now</span><button type="button" className="ghost" onClick={() => store.closeMeetings()}>×</button></div>
        {!store.meetingRooms.length && !goable.length && <p className="muted small">No meetings in their rooms right now. When a calendar meeting starts, its people get a Go button.</p>}
        <ul className="meeting-list">
          {store.meetingRooms.map(r => {
            const a = mine.get(r.id), people = r.members.map(id => store.users.get(id)).filter((u): u is ClientUser => !!u);
            return <li key={r.id}>
              <span><b>{a?.title ?? 'A meeting'}</b> <small className="muted">until {store.clock(r.until)}</small><br /><small>{store.names(people)}</small></span>
              {a && me?.instance !== r.id && <button onClick={() => store.goToMeeting(a.key)}>Go</button>}
            </li>;
          })}
          {goable.map(a => <li key={a.key}>
            <span><b>{a.title}</b> <small className="muted">{store.clock(a.start)}–{store.clock(a.end)}</small><br /><small>nobody's in yet</small></span>
            <button onClick={() => store.goToMeeting(a.key)}>Go</button>
          </li>)}
        </ul>
      </div>
    </div>
  );
}

/** The vault door: where the team's vault lives, and a link that opens it in a new tab. */
function LinkPanel({ store }: { store: Store }) {
  const { label, url } = store.linkOpen!;
  const host = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) store.closeLink(); }}>
      <div className="meet-panel guided">
        <div className="rooms-head"><span>🔐 Vault 13</span><button type="button" className="ghost" onClick={() => store.closeLink()}>×</button></div>
        <p className="small muted">The team's {label} is at <b>{host}</b>. It opens in a new tab.</p>
        <p className="row"><ExternalLink className="button" href={url} onOpen={() => store.closeLink()}>Open the {label} ↗</ExternalLink></p>
      </div>
    </div>
  );
}

/** Your week from Google Calendar, opened from a wall calendar. Only you see it. */
function CalendarPanel({ store }: { store: Store }) {
  const account = store.meetAccount;
  const calendarHome = asAccount('https://calendar.google.com/calendar/r', account);
  const today = new Date(), todayKey = dayKey(today);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const dayLabel = (key: string, d: Date) => key === todayKey ? 'Today' : key === dayKey(tomorrow) ? 'Tomorrow'
    : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  let body: React.ReactNode;
  if (store.google === undefined) body = <p className="muted small">Google isn't set up on this instance.</p>;
  else if (!store.calendarAccess) body = <>
    <p>See your Google Calendar here. The Deck only reads your events; it can't change them, and nobody else sees them.</p>
    <div className="row">{store.calendarAuthUrl
      ? <ExternalLink href={store.calendarAuthUrl} onOpen={() => store.prepareCalendarAuth()}>Connect Google Calendar</ExternalLink>
      : <span className="muted small">…</span>}</div>
  </>;
  else if (store.calendarError) body = <div className="row"><span className="err">Couldn't load your calendar.</span><button className="ghost" onClick={() => store.loadCalendar()}>Retry</button></div>;
  else if (!store.calendarEvents) body = <p className="muted small">Loading…</p>;
  else if (!store.calendarEvents.length) body = <p className="muted small">Nothing on your calendar this week.</p>;
  else {
    const days = new Map<string, { date: Date; events: typeof store.calendarEvents }>();
    for (const e of store.calendarEvents) {
      const start = parseWhen(e.start, e.allDay);
      const key = start < today && !e.allDay ? todayKey : dayKey(start); // started earlier and still going: today
      if (!days.has(key)) days.set(key, { date: start, events: [] });
      days.get(key)!.events.push(e);
    }
    const now = Date.now();
    body = <div className="cal-days">{[...days].map(([key, { date, events }]) => (
      <section key={key}>
        <h4>{dayLabel(key, date)}</h4>
        <ul>{events.map(e => {
          const s = parseWhen(e.start, e.allDay), en = parseWhen(e.end, e.allDay);
          const live = !e.allDay && s.getTime() <= now && now < en.getTime();
          return <li key={e.id} className={`${live ? 'live' : ''}${e.declined ? ' declined' : ''}${!e.allDay && en.getTime() <= now ? ' past' : ''}`}>
            <span className="when">{e.allDay ? 'All day' : `${hm(s)}–${hm(en)}`}</span>
            <ExternalLink href={asAccount(e.link, account)}>{e.title}</ExternalLink>
            {live && <span className="now">now</span>}
            {e.meet && <ExternalLink href={meetAs(e.meet, account)}>Join</ExternalLink>}
          </li>;
        })}</ul>
      </section>
    ))}</div>;
  }
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) store.closeCalendar(); }}>
      <div className="meet-panel guided calendar-panel">
        <div className="rooms-head">
          <span>📅 {account ? `Calendar · ${account}` : 'Your calendar'}</span>
          <button type="button" className="ghost" onClick={() => store.closeCalendar()}>×</button>
        </div>
        {body}
        <div className="row"><ExternalLink href={calendarHome}>Open Google Calendar</ExternalLink></div>
      </div>
    </div>
  );
}

/** Phones and small windows: the floor's controls within thumb reach. */
function Dock({ store, engine, roomsOpen, onRooms }: { store: Store; engine: Engine | null; roomsOpen: boolean; onRooms: () => void }) {
  const z = engine?.zoom;
  const total = [...store.unread.values()].reduce((a, b) => a + b, 0);
  const chatWith = [...store.unread.keys()][0] ?? [...store.chats.keys()].at(-1);
  return (
    <nav className="dock" aria-label="Floor">
      <button className={roomsOpen ? 'on' : ''} aria-pressed={roomsOpen} onClick={onRooms}><span className="ic">👥</span><small>People</small></button>
      <button className={z?.overview ? 'on' : ''} aria-pressed={!!z?.overview} onClick={() => engine?.toggleOverview()}>
        <span className="ic">🗺️</span><small>{z?.overview ? 'Back' : 'Floor'}</small></button>
      <button onClick={() => engine?.recenter()}><span className="ic">📍</span><small>Me</small></button>
      <button onClick={() => (chatWith ? store.openChat(chatWith) : onRooms())} title={chatWith ? undefined : 'Pick someone in People to message'}>
        <span className="ic">💬</span>{total > 0 && <b className="badge">{total}</b>}<small>Chat</small></button>
    </nav>
  );
}

/** 💬 N in the top bar while messages are unread; opens the oldest unread chat (the Rooms panel is often closed). */
function UnreadButton({ store }: { store: Store }) {
  const senders = [...store.unread.keys()]; // insertion order = oldest unread first
  const total = [...store.unread.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  return (
    <button className="unread-btn" onClick={() => store.openChat(senders[0])}
      title={`Unread from ${store.names(senders.map(id => store.users.get(id)!).filter(Boolean))}`}>💬 {total}</button>
  );
}

/** "Mac app" in the top bar (on a Mac, outside the app): the one-line install command to copy. */
function MacAppButton() {
  const [mac, setMac] = useState<{ install: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (inNativeApp() || !/Mac/.test(navigator.platform)) return;
    fetch('/api/mac').then(r => (r.ok ? r.json() : null)).then(setMac).catch(() => {});
  }, []);
  if (!mac) return null;
  const copy = () => navigator.clipboard?.writeText(mac.install).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <div className="mac-app">
      <button className="ghost" onClick={() => setOpen(!open)} title="Install The Deck in your menu bar">Mac app</button>
      {open && (
        <div className="mac-app-pop">
          <b>The Deck in your menu bar</b>
          <p className="muted">Paste this into Terminal. It installs the app and keeps it up to date.</p>
          <code onClick={copy}>{mac.install}</code>
          <button onClick={copy}>{copied ? 'Copied ✓' : 'Copy command'}</button>
        </div>
      )}
    </div>
  );
}

/** Always opens in a new tab — never replaces the office (some shells ignore target=_blank; the Mac app hands it to the browser). */
function openExternal(href: string): boolean {
  const w = window.open(href, '_blank');
  if (w) { w.opener = null; return true; }
  if (inNativeApp()) return true; // the Mac app opened it in the system browser and gave us nothing back
  // popup blocked: fall back to a real new-tab anchor click (iOS ignores this too outside a real click, hence false)
  const a = document.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
  return false;
}
function ExternalLink({ href, onOpen, className, children }: { href: string; onOpen?: () => void; className?: string; children: React.ReactNode }) {
  const open = (e: React.MouseEvent) => { e.preventDefault(); openExternal(href); onOpen?.(); };
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={open}>{children}</a>;
}

const userIcons = (u: ClientUser) => `${u.muted ? ' 🔇' : ''}${u.deafened ? ' 🎧' : ''}${u.hand ? ' ✋' : ''}`;

function EnableSound() {
  return needsGesture() ? <button onClick={() => void resume()}>Enable sound</button> : null;
}

function PersonMenu({ store, at, onClose }: { store: Store; at: PersonMenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const u = store.users.get(at.id);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))}px`;
  });
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('input')?.focus();
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); } };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [at.id]);
  if (!u) return null;
  const reason = store.knockReason(u), away = u.presence === 'offline' || u.door === 'thinking' || u.door === 'leaving';
  const following = store.users.get(store.me)?.following === u.id;
  const value = Math.round((prefs.volumes[u.id] ?? 1) * 100);
  const act = (fn: () => void) => { fn(); onClose(); };
  return <div ref={ref} className="person-menu" role="dialog" aria-label={`${u.name} actions`} style={{ left: at.x, top: at.y }}>
    <div className="rooms-head"><span>{u.name}</span><button className="ghost" aria-label="Close person menu" onClick={onClose}>×</button></div>
    <label className="volume-control"><span>Volume</span><input type="range" min="0" max="200" step="5" value={value} aria-label={`${u.name} volume`}
      onChange={e => { prefs.volumes[u.id] = Number(e.target.value) / 100; savePrefs(); }} /><output>{value}%</output></label>
    <button className={prefs.localMuted[u.id] ? 'muted-btn' : 'ghost'} aria-pressed={!!prefs.localMuted[u.id]}
      onClick={() => { if (prefs.localMuted[u.id]) delete prefs.localMuted[u.id]; else prefs.localMuted[u.id] = true; savePrefs(); }}>Mute for me</button>
    <div className="person-actions">
      <button className="ghost" onClick={() => act(() => store.openChat(u.id))}>Message</button>
      <button className="ghost" disabled={away} onClick={() => act(() => store.follow(following ? null : u.id))}>{following ? 'Unfollow' : 'Follow'}</button>
      <button className="ghost" disabled={!!reason} title={reason ?? 'Knock for a voice call'} onClick={() => act(() => store.requestKnock(u.id))}>Knock</button>
    </div>
  </div>;
}

function SelfPanel({ store, voice }: { store: Store; voice: Voice | null }) {
  const [settings, setSettings] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const me = store.users.get(store.me), room = store.roomCallOf(me), owner = store.connected && store.voiceOwner;
  useEffect(() => {
    if (!settings) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) setSettings(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettings(false); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [settings]);
  const inside = me && room && !me.instance && store.roomOf(me)?.id === room.id;
  const near = me && room ? store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && inside && u.instance === me.instance && store.roomOf(u)?.id === room.id) : [];
  const status = room ? `In ${room.name} · ${near.length ? `within earshot: ${near.map(u => u.name.split(' ')[0]).join(', ')}` : 'nobody within earshot'}`
    : me?.callId ? `Talking with ${store.names(store.callPeers(me))}` : 'Not in voice';
  return <section className="self-controls" ref={ref} aria-label="Your voice controls">
    {settings && <div className="settings-pop" role="dialog" aria-label="Sound settings">
      <div className="rooms-head"><span>Sound settings</span><button className="ghost" aria-label="Close sound settings" onClick={() => setSettings(false)}>×</button></div>
      <label className="input-mode">Input mode<select value={voice?.mode ?? prefs.mode} disabled={!owner || !voice}
        onChange={e => { if (voice && e.target.value !== voice.mode) voice.toggleMode(); }}>
        <option value="voice">Voice activity</option><option value="ptt">Push-to-talk</option>
      </select></label>
      {(['voice', 'music', 'effects'] as Category[]).map(id => <label className="volume-control" key={id}>
        <span>{{ voice: 'Voices', music: 'Music', effects: 'Effects' }[id]}</span>
        <input type="range" min="0" max="100" step="5" value={Math.round(prefs.mix[id] * 100)} aria-label={`${id} volume`}
          onChange={e => { prefs.mix[id] = Number(e.target.value) / 100; savePrefs(); }} /><output>{Math.round(prefs.mix[id] * 100)}%</output>
      </label>)}
    </div>}
    <div className="self-panel">
    <div className="self-heading"><i className="dot" style={{ background: PRESENCE_COLOR[me?.presence ?? 'offline'] }} /><b>{me?.name ?? 'Connecting…'}</b>
      <button className="ghost" aria-label="Sound settings" aria-expanded={settings} onClick={() => setSettings(v => !v)}>⚙</button></div>
    <small className="self-status">{status}</small>
    {store.connected && !owner ? <div className="voice-controls"><span>Voice is on in another tab</span><button onClick={() => store.claimVoice()}>Use voice here</button></div>
      : <div className="voice-controls">
        <button disabled={!owner || !voice} className={voice?.muted ? 'muted-btn' : 'ghost'} aria-pressed={voice?.muted ?? prefs.muted}
          title={voice?.micError ?? undefined} onClick={() => voice?.toggleMute()}>{voice?.muted ? '🔇 Unmute' : voice?.mode === 'ptt' ? '🎙 Hold Space' : '🎙 Mute'}</button>
        <button disabled={!owner || !voice} className={voice?.deafened ? 'muted-btn' : 'ghost'} aria-pressed={voice?.deafened ?? prefs.deafened}
          onClick={() => voice?.toggleDeafen()}>{voice?.deafened ? '🎧 Undeafen' : '🎧 Deafen'}</button>
        {room && <button disabled={!owner} className="ghost" aria-label={me?.hand ? 'Lower hand' : 'Raise hand'} aria-pressed={!!me?.hand} onClick={() => store.setHand(!me?.hand)}>✋</button>}
      </div>}
    {voice?.micError && <small>{voice.micError}</small>}
    {store.voiceWait && <small>Waiting for a spot in {MAP.rooms.find(r => r.id === store.voiceWait)?.name ?? 'room'} voice</small>}
    <EnableSound />
    </div>
  </section>;
}

function voiceState(voice: Voice | null) {
  if (!voice) return 'connecting…';
  if (voice.deafened) return 'deafened';
  if (voice.micError) return 'listen-only';
  if (voice.muted) return 'muted';
  if (voice.connectedCount() < voice.peerCount()) return 'connecting…';
  if (voice.mode === 'ptt') return 'hold Space to talk';
  return 'live';
}

/** Knock calls keep the shared Meet link. */
function CallChip({ store, voice }: { store: Store; voice: Voice | null }) {
  const me = store.users.get(store.me); if (!me?.callId) return null;
  const state = voiceState(voice), peers = store.callPeers(me);
  const meet = store.callLink && MEET_LINK_RE.test(store.callLink) ? store.callLink : null;
  return <div className="desk-chip call-chip knock-panel">
    <span className={`dot ${state === 'live' ? 'live' : ''}`} />
    <span>Talking with {store.names(peers)} <small>· {state}</small></span>
    <button className="end" onClick={() => store.endCall()}>Leave</button>
    {meet && <ExternalLink href={meetAs(meet, store.meetAccount)} onOpen={() => store.moveToMeet()}>Move to Meet</ExternalLink>}
  </div>;
}

/** When you're sitting at a desk chair: claim it, see whose it is, or release yours. */
function DeskChip({ store }: { store: Store }) {
  const me = store.users.get(store.me);
  if (!me) return null;
  const p = store.pose(me);
  const seat = p.walking ? null : seatAt(MAP, p.tile.x, p.tile.y);
  if (!seat?.homeDesk) return null;
  const owner = [...store.users.values()].find(u => u.homeDesk?.x === seat.x && u.homeDesk?.y === seat.y);
  return (
    <div className="desk-chip">
      {!owner && <><span>Free desk</span><button onClick={() => store.claimDesk()}>Make this my desk</button></>}
      {owner?.id === me.id && <><span>Your desk — you'll start here when you come in</span><button className="ghost" onClick={() => store.releaseDesk()}>Release</button></>}
      {owner && owner.id !== me.id && <span>{owner.name}'s desk</span>}
    </div>
  );
}

function Toasts({ store }: { store: Store }) {
  return (
    <div className="toasts">
      {store.toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'knock_in' && <span className="bang">!</span>}
          <span className="txt">{t.text}{t.hint && <small className="hint">{t.hint}</small>}</span>
          {t.kind === 'knock_in' && t.knockId && <>
            <button onClick={() => store.replyKnock(t.knockId!, 'accept')}>Accept</button>
            <button className="ghost" onClick={() => store.replyKnock(t.knockId!, 'later')}>Later</button>
          </>}
          {t.kind === 'knock_out' && t.knockId && <button className="ghost" onClick={() => store.cancelKnock(t.knockId!)}>Cancel</button>}
          {t.kind === 'knock_again' && t.userId && <button onClick={() => { store.dismiss(t.id); store.requestKnock(t.userId!); }}>
            {t.text.startsWith('Missed') ? 'Knock back' : 'Knock again'}
          </button>}
          {t.kind === 'call_moved' && t.roomId && <button onClick={() => { store.joinRoom(t.roomId!); store.dismiss(t.id); }}>Join them</button>}
          {t.kind === 'chat' && t.userId && <button onClick={() => store.openChat(t.userId!)}>Reply</button>}
          {t.kind === 'meeting' && t.meetingKey && <button onClick={() => store.goToMeeting(t.meetingKey!)}>Go</button>}
          {t.kind === 'meeting' && t.link && <ExternalLink href={meetAs(t.link, store.meetAccount)}>Join call</ExternalLink>}
          {t.kind === 'link' && t.link && <ExternalLink href={meetAs(t.link, store.meetAccount)} onOpen={() => store.dismiss(t.id)}>Join Meet</ExternalLink>}
          {t.kind !== 'knock_in' && t.kind !== 'knock_out' && <button className="ghost x" onClick={() => store.dismiss(t.id)}>×</button>}
        </div>
      ))}
    </div>
  );
}

type WheelItem = { icon: string; label: string; onClick: () => void; disabled?: boolean; title?: string; active?: boolean };

/** Click a person or a thing: a ring of actions around it, following it as it moves. */
function ActionWheel({ store, engine, pick, onPerson, onClose }: { store: Store; engine: Engine; pick: Pick; onPerson: (at: PersonMenuAt) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const isMe = pick.kind === 'user' && pick.id === store.me;
  const [emoji, setEmoji] = useState(isMe);
  // the wheel stays where it opened (a moving target is hard to hit); the floor ring shows who it's for
  const [at] = useState(() => engine.anchor(pick));
  useEffect(() => {
    let raf = 0;
    const tick = () => { if (!engine.anchor(pick)) return onClose(); raf = requestAnimationFrame(tick); };
    tick();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', key); };
  }, [engine, pick]);

  const me = store.users.get(store.me);
  const act = (fn: () => void) => () => { fn(); onClose(); };
  let title = '', items: WheelItem[] = [];
  if (pick.kind === 'user') {
    const u = store.users.get(pick.id);
    if (!u || u.presence === 'offline') return null;
    title = isMe ? 'You' : u.name.split(' ')[0];
    if (emoji) {
      items = REACTIONS.map(e => ({ icon: e, label: '', onClick: act(() => store.react(u.id, e)) }));
      const held = isMe && me?.holding ? ITEMS.get(me.holding) : undefined;
      if (!isMe) items.push({ icon: '↩', label: 'Back', onClick: () => setEmoji(false) });
      else if (held) items.push({ icon: held.icon, label: 'Finish', title: `Finish your ${held.label.toLowerCase()}`, onClick: act(() => store.drop()) });
      if (isMe && me?.following) items.push({ icon: '🛑', label: 'Stop following', onClick: act(() => store.follow(null)) });
    } else {
      const away = u.door === 'thinking' || u.door === 'leaving';
      const following = me?.following === u.id, noKnock = store.knockReason(u);
      items = [
        { icon: '✊', label: 'Knock', onClick: act(() => store.requestKnock(u.id)), disabled: !!noKnock,
          title: noKnock ?? 'Knock for a voice call' },
        { icon: '👣', label: following ? 'Unfollow' : 'Follow', active: following, onClick: act(() => store.follow(following ? null : u.id)), disabled: away },
        { icon: '😊', label: 'React', onClick: () => setEmoji(true) },
        { icon: '💬', label: 'Message', onClick: act(() => store.openChat(u.id)) },
      ];
      if (me?.callId && me.callId === u.callId) items.push({ icon: '🔊', label: 'Volume', onClick: act(() => { if (at) onPerson({ id: u.id, x, y }); }) });
      const held = me?.holding ? ITEMS.get(me.holding) : undefined;
      if (held) items.push({ icon: held.icon, label: 'Give', disabled: !!u.holding || away,
        title: u.holding ? `${u.name.split(' ')[0]}'s hands are full` : `Give ${u.name.split(' ')[0]} your ${held.label.toLowerCase()}`,
        onClick: act(() => store.give(u.id)) });
    }
  } else {
    const o = MAP.objects.find(o => o.id === pick.id);
    if (!o?.use || o.use.kind === 'calendar' || o.use.kind === 'meetings' || o.use.kind === 'achievements' || o.use.kind === 'link' || o.use.kind === 'jukebox') return null;
    if (o.use.kind === 'toggle') {
      const on = store.objects[o.id]?.on ?? o.on ?? true;
      title = o.use.label[0].toUpperCase() + o.use.label.slice(1);
      items = [{ icon: on ? '🌑' : '💡', label: on ? 'Turn off' : 'Turn on', onClick: act(() => store.use(o.id)) }];
    } else {
      title = o.type === 'coffee_machine' ? 'Coffee machine' : o.type === 'fridge' ? 'Fridge' : o.type;
      items = o.use.items.map(i => ({ icon: i.icon, label: i.label, onClick: act(() => store.use(o.id, i.id)) }));
    }
  }
  if (!at) return null;
  // buttons ring the sprite without covering it, at any zoom; the whole wheel stays on screen
  const R = Math.max(items.length <= 2 ? 46 : items.length <= 4 ? 56 : 66, at.r + 30);
  const x = Math.round(Math.min(Math.max(at.x, R + 28), window.innerWidth - R - 28));
  const y = Math.round(Math.min(Math.max(at.y, R + 70), window.innerHeight - R - (compact() ? 100 : 30))); // clear of the dock
  // two items sit left/right; more start at the top and go clockwise
  const start = items.length === 2 ? Math.PI : -Math.PI / 2;
  return (
    <div className="wheel" ref={ref} style={{ transform: `translate(${x}px, ${y}px)` }}>
      <div className="wheel-title" style={{ top: -R - 46 }}>{title}</div>
      {items.map((it, i) => {
        const a = start + (i * 2 * Math.PI) / items.length;
        return (
          <button key={i} className={`wheel-item${it.active ? ' active' : ''}${it.label ? '' : ' bare'}`} disabled={it.disabled} title={it.title ?? it.label}
            style={{ left: Math.round(Math.cos(a) * R), top: Math.round(Math.sin(a) * R), animationDelay: `${i * 18}ms` }}
            onClick={e => { e.stopPropagation(); it.onClick(); }}>
            <span className="ic">{it.icon}</span>
            {it.label && <small>{it.label}</small>}
          </button>
        );
      })}
    </div>
  );
}

/** Direct messages with one person. History lives on the server; only the two of you ever get it. */
function ChatPanel({ store, withId }: { store: Store; withId: string }) {
  const other = store.users.get(withId);
  const msgs = store.chats.get(withId) ?? [];
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [msgs.length]);
  const send = () => { store.sendChat(withId, draft); setDraft(''); };
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <aside className="chat" onKeyDown={e => { if (e.key === 'Escape') store.closeChat(); }}>
      <div className="rooms-head">
        <span><i className="pdot" style={{ background: PRESENCE_COLOR[other?.presence ?? 'offline'] }} />{other?.name ?? 'someone'}</span>
        <button className="ghost" onClick={() => store.closeChat()} title="Close">×</button>
      </div>
      <div className="chat-list" ref={listRef}>
        {!msgs.length && <p className="muted">Say hi to {other?.name.split(' ')[0] ?? 'them'} 👋{other?.presence === 'offline' ? ' They\'ll see it when they\'re back.' : ''}</p>}
        {msgs.map(m => (
          <div key={m.id} className={`msg${m.fromId === store.me ? ' mine' : ''}`}>
            <span>{m.text}</span><small>{time(m.at)}</small>
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(); }}>
        <input autoFocus value={draft} maxLength={MAX_CHAT_LEN} placeholder="Message…" onChange={e => setDraft(e.target.value)} />
        <button disabled={!draft.trim()}>Send</button>
      </form>
    </aside>
  );
}
