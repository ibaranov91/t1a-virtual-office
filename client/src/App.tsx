import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadAssets, type Assets } from './assets';
import { Engine, type Pick } from './engine';
import { Voice } from './voice';
import { Soundscape } from './soundscape';
import { needsGesture, resume } from './audio';
import { prefs, savePrefs, type Category } from './prefs';
import { ITEMS, MAP, Store, type ClientUser } from './net';
import { inNativeApp, syncNative } from './native';
import { MAX_CHAT_LEN, MEET_LINK_RE, meetAs, normalizeMeetLink, REACTIONS } from '../../shared/protocol';
import { hallLevel } from '../../shared/acoustics';
import { seatAt } from '../../shared/map';

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
  const [, tick] = useState(0);
  const [engine, setEngine] = useState<Engine | null>(null);

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
      if (use?.kind === 'calendar') { setPick(null); return store.openCalendar(); }
      if (use?.kind === 'meetings') { setPick(null); return store.openMeetings(); }
      setPick(cur => (p && cur?.kind === p.kind && cur.id === p.id ? null : p)); // same target again: close
    };
    e.onZoom = () => tick(n => n + 1);
    engineRef.current = e; setEngine(e);
    if (import.meta.env.DEV) Object.assign(window, { __deck: { store, engine: e } });
    return () => { e.destroy(); setEngine(null); };
  }, [assets, store]);
  useEffect(() => { const i = setInterval(() => { tick(n => n + 1); store.checkAgenda(); }, 1000); return () => clearInterval(i); }, [store]);
  useEffect(() => { if (engineRef.current) engineRef.current.selected = pick; }, [pick]);

  const me = store.users.get(store.me);
  const myRoom = me ? store.roomOf(me) : undefined;

  return (
    <div className="office">
      <TopBar store={store} roomName={myRoom?.name} onToggleRooms={() => setShowRooms(s => !s)} onLogout={onLogout}
        onToggleMeet={() => setShowMeet(s => !s)} engine={engine} />
      <div className="stage">
        <div className="canvas-wrap"><canvas ref={canvasRef} /></div>
        {!assets && <div className="loading">Unlocking the door…</div>}
        {!store.connected && assets && <div className="loading small">Reconnecting…</div>}
        {showRooms && <RoomList store={store} onPerson={openPerson} onClose={() => setShowRooms(false)}
          onPick={id => { engineRef.current?.focusUser(id); if (compact()) setShowRooms(false); }}
          onRoom={id => { engineRef.current?.focusRoom(id); if (compact()) setShowRooms(false); }} />}
        {store.calendarOpen && <CalendarPanel store={store} />}
        {store.meetingsOpen && <MeetingsPanel store={store} />}
        {(showMeet || store.pendingKnock) && <MeetSetup key={store.pendingKnock ?? 'panel'} store={store} onClose={() => setShowMeet(false)} />}
        <div className="chips">
          <MeetingChip store={store} />
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

function TopBar({ store, roomName, onToggleRooms, onToggleMeet, onLogout, engine }: {
  store: Store; roomName?: string; onToggleRooms: () => void; onToggleMeet: () => void; onLogout: () => void; engine: Engine | null;
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
        <input value={status} maxLength={80} placeholder="What are you on?" onChange={e => setDraft(e.target.value)}
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
        <button onClick={onToggleRooms} title="Rooms" className="rooms-btn">Rooms</button>
        <button onClick={onLogout} title="Sign out" className="ghost">Leave</button>
      </div>
    </header>
  );
}

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
      <div className="rooms-head"><span>Rooms</span><button className="ghost" onClick={onClose}>×</button></div>
      {[...MAP.rooms, { id: 'meetings', name: 'In meetings', rules: { label: 'calendar meetings' }, capacity: 0 } as const,
        { id: 'hall', name: 'Hallway', rules: { label: 'passing through' }, capacity: 0 } as const].map(r => {
        const ids = byRoom.get(r.id) ?? [];
        if ((r.id === 'hall' || r.id === 'meetings') && !ids.length) return null;
        return (
          <section key={r.id}>
            <h3 onClick={MAP.rooms.some(m => m.id === r.id) ? () => onRoom(r.id) : undefined}>{r.name} <small>{ids.length}{r.capacity ? `/${r.capacity}` : ''} · {r.rules.label}</small></h3>
            <ul>
              {ids.map(id => {
                const u = store.users.get(id)!;
                return (
                  <li key={id} onContextMenu={e => menu(u, e)} title={u.status || undefined}>
                    <i style={{ background: PRESENCE_COLOR[u.presence] }} />
                    <button className={`ghost person-name${id === store.me ? ' me' : ''}`} onClick={() => onPick(id)}>{u.name}{store.roomCallOf(u) ? ` 🎙${userIcons(u)}` : ''}</button>
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
  if (!me?.instance) return null;
  const m = store.myMeeting, room = store.meetingRooms.find(r => r.id === me.instance);
  const others = (room?.members ?? []).filter(id => id !== me.id).map(id => store.users.get(id)).filter((u): u is ClientUser => !!u);
  return <div className="desk-chip call-chip meeting-chip">
    <span>📅 <b>{m?.title ?? 'Meeting'}</b> <small>· until {store.clock(room?.until ?? m?.end ?? 0)}{others.length ? ` · with ${store.names(others)}` : ' · waiting for the others'}</small></span>
    {m?.link && <ExternalLink href={meetAs(m.link, store.meetAccount)}>Join call</ExternalLink>}
    <button className="end" onClick={() => store.leaveMeeting()}>Leave</button>
  </div>;
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
      <button className={roomsOpen ? 'on' : ''} aria-pressed={roomsOpen} onClick={onRooms}><span className="ic">👥</span><small>Rooms</small></button>
      <button className={z?.overview ? 'on' : ''} aria-pressed={!!z?.overview} onClick={() => engine?.toggleOverview()}>
        <span className="ic">🗺️</span><small>{z?.overview ? 'Back' : 'Floor'}</small></button>
      <button onClick={() => engine?.recenter()}><span className="ic">📍</span><small>Me</small></button>
      <button onClick={() => (chatWith ? store.openChat(chatWith) : onRooms())} title={chatWith ? undefined : 'Pick someone in Rooms to message'}>
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

/** Always opens in a new tab — never replaces the office (some shells ignore target=_blank). */
function ExternalLink({ href, onOpen, children }: { href: string; onOpen?: () => void; children: React.ReactNode }) {
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    const w = window.open(href, '_blank');
    if (w) w.opener = null;
    else { // popup blocked: fall back to a real new-tab anchor click
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
    }
    onOpen?.();
  };
  return <a href={href} target="_blank" rel="noopener noreferrer" onClick={open}>{children}</a>;
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
  const myLevel = me && room ? hallLevel(MAP, room, store.pose(me).tile) : 0;
  const near = me && room ? store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && myLevel * hallLevel(MAP, room, store.pose(u).tile) > .02) : [];
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
    if (!o?.use || o.use.kind === 'calendar' || o.use.kind === 'meetings') return null;
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
