import { onMap } from '../../shared/beach';
import { AchievementsPanel, AchievementBadge, AchievementRarity } from './Achievements.jsx';
import { VacationPanel } from './Vacation';
import { ProfilePopout } from './sidebar/ProfilePopout';
import { Sidebar } from './sidebar/Sidebar';
import { PersonCard, type PersonAnchor } from './sidebar/PersonCard';
import { RoomMenu, type RoomAnchor } from './sidebar/RoomMenu';
import { HoverCard } from './HoverCard';
import { PRESENCE_COLOR, offsetOf } from './sidebar/model';
import { COMPACT, overlayOpen, useMedia } from './sidebar/hooks';
import { IdentityPill, VoiceIcons, CallChip, RoomVoiceChip, voiceState } from './sidebar/SelfPanel';
import { RetroOverlay } from './retro/RetroOverlay';
import { INSTRUMENTS, DRUM_PADS, VELOCITIES, VELOCITY_START, keyNote, noteName, type InstrumentKind } from '../../shared/instruments';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadAssets, type Assets } from './assets';
import { BrandLogo } from './BrandLogo';
import { Engine, type Pick } from './engine';
import { Voice } from './voice';
import { Icon, IconButton } from './Icon';
import { VoiceToggle } from './VoiceToggle';
import { ArcadeOverlay, RecordsPopover } from './park/ArcadeOverlay';
import { LofiTV } from './LofiTV';
import { Soundscape } from './soundscape';
import { needsGesture, resume } from './audio';
import { prefs, savePrefs } from './prefs';
import { ITEMS, MAP, Store, heldItem, type ClientUser } from './net';
import { slurBy } from './slur';
import { DRINKS, isEmpty } from '../../shared/drinks';
import { inNativeApp, syncNative } from './native';
import { ExternalLink } from './links';
import { fakeShare } from './share';
import { LiveChip, PresentPanel, SlideOverlay } from './Presentation';
import { RoomPopup } from './RoomPopup';
import { LibraryPanel, ReadingOverlay } from './Library';
import { Wellness } from './WellnessPanel';
import { TerminalPanel } from './Terminal';
import { ACHIEVEMENTS, goingOut, LOOK_COLORS, underground, dayNumber, JUKEBOX_PER_PERSON, JUKEBOX_QUEUE_MAX, MAX_CHAT_LEN, ROOM_VOICE_MAX, meetAs, normalizeMeetLink, plantDead, REACTIONS, TOILET_CAPACITY, TOILET_SHELF_ITEM, TOILET_SHELF_MAX, TOILET_USE_MS, toiletFull, type JukeboxState, type Plant } from '../../shared/protocol';
import { jukeboxPosition, TRACK, tracksFor } from '../../shared/music';
import { ALL_HATS, DANCE_ROOM, EFFECTS, HAT_NAMES, REFRESHMENT_HINTS, effectOf, hatOf } from '../../shared/effects';
import { FIXED_TYPES, KEEP_TYPES, objectName, RUG_COLORS, RUG_MAX, RUG_MIN, RUG_PATTERNS, SEAT_TYPES, routes, rugFrame, seatAt } from '../../shared/map';
import { picnicSeat } from '../../shared/lunch';

// The game table (and chess.js) loads the first time someone sits down at it.
const TableOverlay = lazy(() => import('./table/TableOverlay').then(m => ({ default: m.TableOverlay })));

// Dev server: sign in automatically as ?as=<name> (default "Dev"); each name keeps its own session,
// so several tabs can be different people.
const DEV_AS = import.meta.env.DEV ? (new URLSearchParams(location.search).get('as')?.trim() || 'Dev') : null;
const SESSION_KEY = DEV_AS ? `deck.session.dev.${DEV_AS.toLowerCase()}` : 'deck.session';
/** Phones and small windows: a thumb dock and bottom sheets (keep in step with styles.css). */
const compact = () => window.matchMedia(COMPACT).matches;

/** On a direct talk inside a hall or stall: the place is talking too; one button leaves the talk and joins it. */
function TalkConflictChip({ store }: { store: Store }) {
  const me = store.users.get(store.me), where = store.talkConflict();
  if (!me || !where) return null;
  return <div className="desk-chip call-chip talk-conflict" role="status">
    <span>On a call with {store.names(store.callPeers(me))} <small>· {where} is talking here</small></span>
    <button onClick={() => store.endCall()}>{where === 'the stall' ? 'Join the stall' : `Join ${where}`}</button>
  </div>;
}

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

type Config = { netbird: boolean; tokenLogin: boolean; tokenRequired?: boolean; emailLogin?: boolean };

function Login({ onLogin }: { onLogin: (s: string) => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [nb, setNb] = useState<{ email: string; name: string } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
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
        {config?.emailLogin && (
          <form onSubmit={e => { e.preventDefault(); post('/api/login', { email }); }} className="token-form">
            <label>Your email<input autoFocus type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@t1a.com" /></label>
            <button disabled={!/\S+@\S+/.test(email) || busy}>Walk in</button>
          </form>
        )}
        {config?.tokenLogin && !config.emailLogin && (
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
  const [assets, setAssets] = useState<Assets | null>(null), [assetsFailed, setAssetsFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (chromeRef.current) chromeRef.current.inert = store.gameOpen || !!store.table; }, [store.gameOpen, store.table]);
  const engineRef = useRef<Engine | null>(null);
  const [showRooms, setShowRooms] = useState(false);
  const isCompact = useMedia(COMPACT);
  const sidebarRef = useRef<{ close: () => void }>(null);
  const [roomMenu, setRoomMenu] = useState<RoomAnchor | null>(null);
  const [showMeet, setShowMeet] = useState(false);
  const [tv, setTv] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [personMenu, setPersonMenu] = useState<PersonAnchor | null>(null);
  const openPerson = (at: PersonAnchor) => { setPick(null); setRoomMenu(null); setPersonMenu(at); };
  const [showAppearance, setShowAppearance] = useState(false);
  const [, tick] = useState(0);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [editing, setEditing] = useState(false);
  const [gmOpen, setGmOpen] = useState(false);
  const [pocketsOpen, setPocketsOpen] = useState(false);

  useEffect(() => {
    store.connect();
    window.addEventListener('online', store.reconnectNow);
    return () => { window.removeEventListener('online', store.reconnectNow); store.close(); };
  }, [store]);
  useEffect(() => { const s = new Soundscape(store); return () => s.destroy(); }, [store]);
  // Receive connections start before microphone permission settles.
  const [voice, setVoice] = useState<Voice | null>(null);
  useEffect(() => syncNative(store, voice), [store, voice]);
  useEffect(() => {
    let v: Voice | null = null, unsub = () => {}, cancelled = false;
    // Without the config, voice still starts: host candidates connect directly on NetBird.
    fetch('/api/config').then(r => r.json()).then(c => c.iceServers ?? [], () => []).then(iceServers => {
      if (cancelled) return;
      v = new Voice(store, iceServers);
      unsub = store.subscribe(() => v!.sync());
      v.sync(); setVoice(v);
      if (import.meta.env.DEV) Object.assign(window, { __voice: v });
    });
    return () => { cancelled = true; unsub(); v?.destroy(); };
  }, [store]);
  useEffect(() => { loadAssets().then(setAssets, e => { console.warn('could not load the art:', e); setAssetsFailed(true); }); }, []);
  useEffect(() => {
    if (!assets || !canvasRef.current) return;
    const e = new Engine(canvasRef.current, store, assets);
    e.onPick = p => {
      // a wall calendar opens your calendar right away (nothing to walk over for)
      const use = p?.kind === 'object' ? MAP.objects.find(o => o.id === p.id)?.use : undefined;
      if (use?.kind === 'wellness') { setPick(null); return store.openWellness(use.activity); }
      if (use?.kind === 'instrument' && p) { setPick(null); return store.playInstrument(p.id); }
      if (use?.kind === 'table' && p) { setPick(null); return store.use(p.id); }
      if ((use?.kind === 'arcade' || use?.kind === 'retro') && p) { setPick(null); return store.use(p.id); }
      if (use?.kind === 'dance' && p) { setPick(null); return store.dance(p.id); }
      if (use?.kind === 'records') { setPick(null); return store.openRecords(); }
      if (use?.kind === 'youtube' && p) { setPick(null); return setTv(p.id); }
      if (use?.kind === 'jukebox' && p) { setPick(null); return store.openJukebox(p.id); }
      if (use?.kind === 'bell' && p) { setPick(null); return store.ring(p.id); }
      if (use?.kind === 'library') { setPick(null); return store.openLibrary(); }
      if (use?.kind === 'calendar') { setPick(null); return store.openCalendar(); }
      if (use?.kind === 'clock') { setPick(null); return store.openClock(); }
      if (use?.kind === 'vacations') { setPick(null); return store.openVacations(); }
      if (use?.kind === 'meetings') { setPick(null); return store.openMeetings(); }
      if (use?.kind === 'achievements') { setPick(null); return store.openEmployeeBoard(); }
      if (use?.kind === 'tickets' && p) { setPick(null); return store.use(p.id); } // walks to the terminal; the server opens its screen on arrival
      if (use?.kind === 'presentation' && p) { setPick(null); return store.use(p.id); } // walks to the board; the server opens the panel on arrival
      if (use?.kind === 'room_start' && p) { setPick(null); return store.use(p.id); } // walks to the sign; the server sends room_open on arrival
      if (use?.kind === 'link') { setPick(null); return store.openLink(use); } // a panel, like the calendar: its link is a real tap
      setPick(cur => (p && cur?.kind === p.kind && cur.id === p.id ? null : p)); // same target again: close
    };
    e.onZoom = () => tick(n => n + 1);
    e.onEditChange = () => { setEditing(e.editing); tick(n => n + 1); };
    engineRef.current = e; setEngine(e);
    if (import.meta.env.DEV) Object.assign(window, { __deck: { store, engine: e, share: { fake: (id?: string) => fakeShare(store, id) } } });
    return () => { e.destroy(); setEngine(null); };
  }, [assets, store]);
  useEffect(() => { const i = setInterval(() => { tick(n => n + 1); store.checkAgenda(); }, 1000); return () => clearInterval(i); }, [store]);
  useEffect(() => { if (engineRef.current) engineRef.current.selected = pick; }, [pick]);
  useEffect(() => { // the browser hasn't unlocked audio yet: say so once (the settings popover keeps an Enable sound button)
    const t = setTimeout(() => {
      if (needsGesture()) store.toast({ kind: 'info', text: '🔈 Sound is off until you click', hint: 'Browsers wait for a click before playing audio', expires: 8000,
        actions: [{ label: 'Enable sound', run: () => void resume() }] });
    }, 2500);
    return () => clearTimeout(t);
  }, [store]);
  const me = store.users.get(store.me);
  const down = !!me && underground(me);
  useEffect(() => { engine?.setEditing(editing && store.admin && !down); }, [engine, editing, store.admin, down]);
  useEffect(() => { setPick(null); setPersonMenu(null); setEditing(false); }, [down]);
  const [profileOpener, setProfileOpener] = useState<HTMLButtonElement | null>(null);
  const openProfile = (opener: HTMLButtonElement) => {
    if (overlayOpen(store)) return;
    opener.focus(); setPersonMenu(null); setRoomMenu(null); setProfileOpener(opener);
  };
  const profileAction = (run: () => void) => { setShowRooms(false); sidebarRef.current?.close(); run(); };
  const myRoom = me ? store.roomOf(me) : undefined;
  useEffect(() => { if (me && !me.lookSet) setShowAppearance(true); }, [me?.id, me?.lookSet]);

  return (
    <div className="office">
      <div className="office-chrome" ref={chromeRef}>
      <TopBar store={store} assets={assets} voice={voice} roomName={myRoom?.name}
        onToggleMeet={() => setShowMeet(s => !s)} onProfile={openProfile}
        editing={editing} onToggleEdit={() => setEditing(e => !e)} gmOpen={gmOpen} onToggleGm={() => { setGmOpen(o => !o); setPocketsOpen(false); }} />
      <div className="workspace">
        {!isCompact && <Sidebar ref={sidebarRef} store={store} voice={voice} engine={engine} assets={assets} onPerson={openPerson}
          onRoom={at => { setPersonMenu(null); setRoomMenu(at); }} onProfile={openProfile} surfaceOpen={!!(personMenu || roomMenu || profileOpener)} />}
      <div className={`stage${editing && store.admin && !down && engine ? ' editing' : ''}`}>
        <div className="canvas-wrap"><canvas ref={canvasRef} /></div>
        {engine && <HoverCard store={store} engine={engine} assets={assets} compact={isCompact} />}
        {engine && <ZoomCluster engine={engine} />}
        {!assets && <div className="loading">{assetsFailed ? 'The office didn\'t load. Reload the page to try again.' : 'Unlocking the door…'}</div>}
        {!store.connected && assets && <div className="loading small">Reconnecting…</div>}
        {store.presentation && store.inPresentationRoom() && !store.slidesHidden && <SlideOverlay store={store} />}
        {isCompact && <Sidebar ref={sidebarRef} store={store} voice={voice} engine={engine} assets={assets} sheetOpen={showRooms}
          onCloseSheet={() => setShowRooms(false)} onPerson={openPerson} onRoom={at => { setPersonMenu(null); setRoomMenu(at); }} onProfile={openProfile} surfaceOpen={!!(personMenu || roomMenu || profileOpener)} />}
        {editing && store.admin && !down && engine && <EditPanel store={store} engine={engine} assets={assets} onDone={() => setEditing(false)} />}
        {gmOpen && store.admin && !editing && <GmPanel store={store} picked={pick?.kind === 'user' ? pick.id : null} assets={assets} onClose={() => setGmOpen(false)} />}
        {pocketsOpen && me && <PocketsPanel store={store} me={me} assets={assets} onClose={() => setPocketsOpen(false)} />}
        {store.calendarOpen && <CalendarPanel store={store} />}
        {store.laterOpen && <LaterPanel store={store} />}
        {store.vacationsOpen && <VacationPanel store={store} engine={engineRef.current} />}
        {store.meetingsOpen && <MeetingsPanel store={store} />}
        {store.libraryOpen && <LibraryPanel store={store} />}
        {store.terminalOpen && <TerminalPanel store={store} />}
        {me?.reading && <ReadingOverlay key={`reading:${me.reading}`} store={store} articleId={me.reading} />}
        {tv && <LofiTV store={store} id={tv} onClose={() => setTv(null)} />}
        {store.jukeboxOpen && <JukeboxPanel key={`jukebox:${store.jukeboxOpen}`} store={store} id={store.jukeboxOpen} />}
        {store.recordsOpen && <RecordsPopover store={store} />}
        {store.linkOpen && <LinkPanel store={store} />}
        {store.roomOpen && <RoomPopup store={store} />}
        {store.presentOpen && <PresentPanel key={`present:${store.presentOpen}`} store={store} id={store.presentOpen} />}
        {store.clockOpen && <ClockPanel store={store} />}
        {store.achievementsOpen && me && <AchievementsPanel store={store} me={me} assets={assets} backdrop={backdropClose(() => store.openAchievements(false))} />}
        {store.employeeOpen && <EmployeePanel store={store} />}
        {showMeet && <MeetSetup store={store} onClose={() => setShowMeet(false)} />}
        {showAppearance && me && <AppearanceMenu key={`appearance:${me.id}`} look={me.look} name={me.name} assets={assets} firstTime={!me.lookSet} store={store}
          onSave={(look, name) => { store.setLook(look, name); setShowAppearance(false); }} onClose={() => setShowAppearance(false)} />}
        <div className="chips">
          <MeetingChip store={store} voice={voice} />
          <LiveChip store={store} onGo={room => engineRef.current?.walkToRoom(room)} />
          <NowPlayingChip store={store} />
          <DungeonChip store={store} />
          {me?.callId && !me.instance && !store.roomCallOf(me) && store.voiceOwner && <CallChip store={store} voice={voice} />}
          <RoomVoiceChip store={store} voice={voice} />
          <TalkConflictChip store={store} />
          <DeskChip store={store} />
        </div>
        <Toasts store={store} />
        {pick && engineRef.current && <ActionWheel key={`${pick.kind}:${pick.id}`} store={store} engine={engineRef.current} pick={pick} assets={assets} onPerson={openPerson} onClose={() => setPick(null)} />}
        <div className="self-stack">
          {store.chatWith && <ChatPanel key={store.chatWith} store={store} withId={store.chatWith} />}
        </div>
        {profileOpener && <ProfilePopout store={store} assets={assets} engine={engine} compact={isCompact} opener={profileOpener}
          thirsty={!!me?.plant && needsWater(me.plant, store.now())} onClose={() => setProfileOpener(null)}
          onAppearance={() => profileAction(() => setShowAppearance(true))}
          onPockets={() => profileAction(() => { setPocketsOpen(true); setGmOpen(false); })}
          onAchievements={() => profileAction(() => store.openAchievements(true))} onLogout={onLogout} />}
        {personMenu && <PersonCard key={`person:${personMenu.id}`} store={store} engine={engine} assets={assets} at={personMenu} compact={isCompact}
          onClose={() => setPersonMenu(null)} onAction={() => { setPersonMenu(null); setShowRooms(false); sidebarRef.current?.close(); }}
          onAppearance={() => setShowAppearance(s => me?.lookSet ? !s : true)} />}
        {roomMenu && <RoomMenu key={`room:${roomMenu.id}`} store={store} engine={engine} at={roomMenu} compact={isCompact} onTv={setTv}
          onClose={() => setRoomMenu(null)} onAction={() => { setRoomMenu(null); setShowRooms(false); sidebarRef.current?.close(); }} />}
        {store.seat && <InstrumentPanel key={`seat:${store.seat}`} store={store} id={store.seat}
          dialogOpen={!!(store.wellnessOpen || store.table || showAppearance || showMeet || store.calendarOpen || store.laterOpen || store.meetingsOpen || store.vacationsOpen || store.clockOpen || store.jukeboxOpen || store.libraryOpen || store.terminalOpen || !!me?.reading || store.achievementsOpen || store.employeeOpen || store.presentOpen || store.roomOpen || store.chatWith || personMenu || roomMenu || profileOpener || pick)} />}
        <Dock store={store} voice={voice} engine={engine} roomsOpen={showRooms} onRooms={() => setShowRooms(s => !s)} />
        {me && <Wellness key={`wellness:${me.id}`} store={store} userId={me.id} />}
      </div>
      </div>
      </div>
      {store.table && assets && <Suspense fallback={null}><TableOverlay store={store} assets={assets} /></Suspense>}
      {store.retro && <RetroOverlay store={store} />}
      {store.arcadeOpen && assets && store.park && <ArcadeOverlay store={store} assets={assets} voice={voice} />}
    </div>
  );
}

function InstrumentPanel({ store, id, dialogOpen }: { store: Store; id: string; dialogOpen: boolean }) {
  const object = MAP.objects.find(o => o.id === id);
  const kind: InstrumentKind = object?.use?.kind === 'instrument' ? object.use.instrument : 'keys';
  const info = INSTRUMENTS[kind];
  const [settings, setSettings] = useState({ octave: info.octave?.start ?? 4, velocity: VELOCITY_START, preset: 0 });
  const config = useRef(settings); config.current = settings;
  const dialog = useRef(dialogOpen); dialog.current = dialogOpen;
  const held = useRef(new Map<string, number>());
  const [lit, setLit] = useState<string[]>([]);
  const change = (next: typeof settings) => { config.current = next; setSettings(next); };
  useEffect(() => {
    const keys = held.current;
    const releaseAll = () => {
      if (kind !== 'drums') for (const pitch of new Set(keys.values())) {
        if (store.seat === id) store.sendNote(pitch, false);
        else store.soundscape?.allOff(id, store.me);
      }
      keys.clear(); setLit([]);
    };
    const down = (e: KeyboardEvent) => {
      if (store.seat !== id || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey ||
        (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) return;
      if (e.code === 'Escape') {
        if (!dialog.current && !document.querySelector('[role="dialog"], .modal-backdrop, .appearance-backdrop')) {
          e.preventDefault(); releaseAll(); store.leaveInstrument();
        }
        return;
      }
      const current = config.current, pitch = keyNote(kind, e.code, current.octave);
      if (pitch !== null) {
        e.preventDefault(); if (keys.has(e.code)) return;
        const already = [...keys.values()].includes(pitch);
        keys.set(e.code, pitch); setLit([...keys.keys()]);
        if (kind === 'drums' || !already) store.sendNote(pitch, true, VELOCITIES[current.velocity], current.preset);
        return;
      }
      const next = { ...current };
      if ((e.code === 'KeyZ' || e.code === 'KeyX') && info.octave) next.octave = Math.max(info.octave.min, Math.min(info.octave.max, current.octave + (e.code === 'KeyZ' ? -1 : 1)));
      else if (e.code === 'KeyC' || e.code === 'KeyV') next.velocity = Math.max(0, Math.min(VELOCITIES.length - 1, current.velocity + (e.code === 'KeyC' ? -1 : 1)));
      else if (/^Digit[1-3]$/.test(e.code) && Number(e.code.slice(5)) <= info.presets.length) next.preset = Number(e.code.slice(5)) - 1;
      else return;
      e.preventDefault(); config.current = next; setSettings(next);
    };
    const up = (e: KeyboardEvent) => {
      const pitch = keys.get(e.code); if (pitch === undefined) return;
      e.preventDefault(); keys.delete(e.code); setLit([...keys.keys()]);
      if (kind !== 'drums' && ![...keys.values()].includes(pitch) && store.seat === id) store.sendNote(pitch, false);
    };
    const visibility = () => { if (document.hidden) releaseAll(); };
    const unsubscribe = store.subscribe(() => { if (store.seat !== id) releaseAll(); });
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAll); document.addEventListener('visibilitychange', visibility);
    return () => {
      releaseAll(); unsubscribe(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll); document.removeEventListener('visibilitychange', visibility);
    };
  }, [store, id, kind]);
  const key = (code: string, label: string, black = false, position?: number) => <div key={code}
    className={`typing-key${black ? ' black' : ''}${lit.includes(code) ? ' held' : ''}`}
    style={position === undefined ? undefined : { left: `${position / 11 * 100}%` }}>
    <b>{label}</b><small>{noteName(keyNote(kind, code, settings.octave)!)}</small>
  </div>;
  return <section className="instrument-panel" aria-label={`${info.name} musical typing`}>
    <div className="instrument-head"><strong>{info.icon} {info.name}</strong>
      <button className="ghost" onClick={() => store.leaveInstrument()}>Esc — stand up</button></div>
    <div className="instrument-presets">{info.presets.map((preset, n) => <button key={preset} aria-pressed={settings.preset === n}
      className={settings.preset === n ? 'on' : 'ghost'} onClick={() => change({ ...config.current, preset: n })}>{n + 1} {preset}</button>)}</div>
    <div className="instrument-settings">{info.octave && <span>Octave {settings.octave} (Z X)</span>}<span>Velocity {VELOCITIES[settings.velocity]} (C V)</span></div>
    {kind === 'drums' ? <div className="drum-pads">{Object.entries(DRUM_PADS).map(([code, pad]) => <div key={code} className={`drum-pad${lit.includes(code) ? ' held' : ''}`}><b>{code === 'Semicolon' ? ';' : code.slice(3)}</b><span>{pad.name}</span></div>)}</div>
      : <div className="typing-keyboard"><div className="typing-whites">{['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','Semicolon','Quote'].map(code => key(code, code === 'Semicolon' ? ';' : code === 'Quote' ? "'" : code.slice(3)))}</div>
        {([['KeyW',1],['KeyE',2],['KeyT',4],['KeyY',5],['KeyU',6],['KeyO',8],['KeyP',9]] as const).map(([code, pos]) => key(code, code.slice(3), true, pos))}</div>}
    <p className="instrument-touch-hint">Plug in a keyboard to play</p>
  </section>;
}

function TopBar({ store, assets, voice, roomName, onToggleMeet, onProfile, editing, onToggleEdit, gmOpen, onToggleGm }: {
  store: Store; assets: Assets | null; voice: Voice | null; roomName?: string; onToggleMeet: () => void; onProfile: (opener: HTMLButtonElement) => void;
  editing: boolean; onToggleEdit: () => void; gmOpen: boolean; onToggleGm: () => void;
}) {
  const me = store.users.get(store.me);
  const [more, setMore] = useState(false);
  const isCompact = useMedia(COMPACT);
  useEffect(() => { // the ⋯ menu closes on a tap anywhere else
    if (!more) return;
    const off = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.topbar')) setMore(false); };
    window.addEventListener('pointerdown', off);
    return () => window.removeEventListener('pointerdown', off);
  }, [more]);
  return (
    <header className="topbar">
      <div className="top-left">
        <BrandLogo store={store} assets={assets} />
        {isCompact && me && <IdentityPill store={store} onProfile={onProfile} roomName={roomName} />}
      </div>
      <div className="top-right">
        {isCompact && <VoiceIcons store={store} voice={voice} />}
        <UnreadButton store={store} />
        <LaterButton store={store} />
        <button className="chip ghost more-btn" aria-label="More" aria-expanded={more} onClick={() => setMore(m => !m)}><Icon name="more" /></button>
        <div className={`top-more${more ? ' open' : ''}`} onClick={e => { if (!(e.target as HTMLElement).closest('.mac-app')) setMore(false); }}>
          <button onClick={onToggleMeet} className={`chip meet-btn${store.meetLink === '' && !store.google ? ' unset' : ''}`}
            title={store.google ? `Google connected: ${store.google}` : store.meetLink ? `Your Meet room: ${store.meetLink}` : 'Set up Google Meet'} aria-label="Meet"><Icon name="monitor" /><span className="meet-label">Meet</span></button>
          <MacAppButton />
        </div>
        <div className="hangers">
          {store.admin && me && !underground(me) && <button onClick={onToggleEdit} className={`chip hanger-btn${editing ? ' on' : ''}`} aria-pressed={editing}
            title={editing ? 'Done rearranging' : 'Rearrange the office (admins)'} aria-label="Rearrange the office">
            <Icon name="edit" />
          </button>}
          {store.admin && me && <button onClick={onToggleGm} className={`chip hanger-btn gm-btn${gmOpen ? ' on' : ''}`} aria-pressed={gmOpen}
            title="GM superpowers: buffs and debuffs (admins)" aria-label="GM superpowers"><Icon name="sparkles" /></button>}
        </div>
      </div>
    </header>
  );
}

/** Whether colleagues see my local time, and which zone: the browser's, or one picked by hand (a laptop set to the wrong zone, a VPN). */
function TimeZoneField({ store }: { store: Store }) {
  const zones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } }, []);
  const picked = store.pickedTz, shown = picked ?? store.detectedTz;
  return (
    <div className="tz-field small muted" title="Colleagues see your local time when they hover over you. Only the time zone is shared, not your location.">
      <label><input type="checkbox" checked={store.shareTz} onChange={e => store.setShareTz(e.target.checked)} /> Show my local time</label>
      <select value={picked ?? ''} disabled={!store.shareTz} onChange={e => store.setPickedTz(e.target.value || null)} aria-label="Time zone">
        <option value="">Automatic: {store.detectedTz}</option>
        {zones.filter(z => z !== store.detectedTz || picked).map(z => <option key={z} value={z}>{z}</option>)}
      </select>
      {store.shareTz && <span>{new Intl.DateTimeFormat([], { timeZone: shown, hour: '2-digit', minute: '2-digit' }).format(new Date())} now</span>}
    </div>
  );
}
function AppearanceMenu({ look, name, assets, firstTime, store, onSave, onClose }: {
  look: PublicLook; name: string; assets: Assets | null; firstTime: boolean; store: Store; onSave: (look: PublicLook, name: string) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(look);
  const [nameDraft, setNameDraft] = useState(name);
  const [tab, setTab] = useState<'body' | 'clothes' | 'accessories'>('body');
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
  const select = (label: string, value: number, options: string[], key: 'style' | 'top' | 'bottom' | 'glasses' | 'hat' | 'beard' | 'mustache') => (
    <label className="look-select">{label}<select value={value} onChange={e => set(key, Number(e.target.value))}>
      {options.map((option, i) => <option value={i} key={option}>{option}</option>)}
    </select></label>
  );
  const styleLabels: Record<string, string> = { short: 'Short', long: 'Long', ponytail: 'Short ponytail', bald: 'Bald', receding: 'Receding hairline' };
  const styles = (assets?.atlas.character.styles ?? ['short', 'long', 'ponytail', 'bald', 'receding']).map(s => styleLabels[s] ?? s[0].toUpperCase() + s.slice(1));
  const tops = assets?.atlas.character.tops ?? ['T-shirt', 'Button-up shirt', 'Sweater'];
  const bottoms = assets?.atlas.character.bottoms ?? ['Trousers', 'Skirt', 'Shorts'];
  return (
    <div className="appearance-backdrop" onClick={e => { if (e.target === e.currentTarget && !firstTime) onClose(); }}>
      <section className="appearance-panel" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
        <header className="appearance-head"><div><h2 id="appearance-title">Your character</h2><p>{firstTime ? 'Choose your look before stepping into the office.' : 'Make the office feel a little more like you.'}</p></div>
          {!firstTime && <button className="ghost" onClick={onClose} aria-label="Close appearance settings"><Icon name="close" /></button>}</header>
        <div className="appearance-preview"><div className="avatar-frame"><canvas ref={previewRef} /></div>
          <label className="look-select">Name<input value={nameDraft} maxLength={24} placeholder="First Las" onChange={e => setNameDraft(e.target.value)} /></label></div>
        <nav className="appearance-tabs" aria-label="Appearance categories">
          <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>Body</button>
          <button className={tab === 'clothes' ? 'active' : ''} onClick={() => setTab('clothes')}>Clothes</button>
          <button className={tab === 'accessories' ? 'active' : ''} onClick={() => setTab('accessories')}>Accessories</button>
        </nav>
        <div className="appearance-options">
          {tab === 'body' ? <>
            {select('Hairstyle', draft.style, styles, 'style')}
            {colors('Hair color', 'hair')}{colors('Skin tone', 'skin')}{colors('Eye color', 'eyes')}
          </> : tab === 'clothes' ? <>
            {select('Top', draft.top, tops, 'top')}{colors('Top color', 'shirt')}
            {select('Bottom', draft.bottom, bottoms, 'bottom')}{colors('Bottom color', 'pants')}
            {colors('Shoe color', 'shoes')}
            <p className="small">Hats are in your pockets 🎒 (take one from the Lobby hat stand)</p>
          </> : <>
            {select('Glasses', draft.glasses, ['None', 'Round', 'Black sunglasses'], 'glasses')}
            {select('Beard', draft.beard, ['None', 'Beard'], 'beard')}
            {select('Mustache', draft.mustache, ['None', 'Mustache'], 'mustache')}
            {draft.glasses === 1 && colors('Glasses color', 'glassesColor')}
            <p className="small">Beard and mustache use your hair color.</p>
          </>}
        </div>
        <footer className="appearance-actions">
          <TimeZoneField store={store} />
          {!firstTime && <button className="ghost" onClick={onClose}>Cancel</button>}
          <button onClick={() => onSave(draft, nameDraft.trim())}>{firstTime ? 'Save & enter office' : 'Save changes'}</button>
        </footer>
      </section>
    </div>
  );
}

type PublicLook = import('../../shared/protocol').Look;

/** Meet room setup, from the Meet button: connect Google, or paste a reusable room of your own. */
function MeetSetup({ store, onClose }: { store: Store; onClose: () => void }) {
  const [value, setValue] = useState(store.meetLink ?? '');
  const parsed = value.trim() ? normalizeMeetLink(value) : '';
  const save = (link: string) => { store.setMeetLink(link); onClose(); };
  const pasteFromClipboard = async () => { try { setValue(await navigator.clipboard.readText()); } catch { /* not allowed: user pastes by hand */ } };
  const google = store.google;
  useEffect(() => { if (google === null) store.prepareGoogle(); }, [store, google]);
  return (
    <div>
      <form className="meet-panel" onSubmit={e => { e.preventDefault(); if (parsed) save(parsed); }}>
        <div className="rooms-head">
          <span>{google ? 'Google Meet' : 'Your Google Meet room'}</span>
          <button aria-label="Close" type="button" className="ghost" onClick={onClose}><Icon name="close" /></button>
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
        <p className="muted">When you knock and they accept, you both join this room.</p>
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
          {store.meetLink && <button type="button" className="ghost" onClick={() => save('')}>Clear</button>}
          <button disabled={!parsed || parsed === store.meetLink}>Save</button>
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
function MeetingChip({ store, voice }: { store: Store; voice: Voice | null }) {
  const me = store.users.get(store.me);
  if (!me || underground(me)) return null;
  if (!me.instance) { // out of the room but still in the meeting: rejoin, or leave it for good
    const a = me.meeting ? store.myBusyMeeting : null;
    if (!a) return null;
    return <div className="desk-chip call-chip meeting-chip">
      <span>📅 <b>{a.title}</b> <small>· in the meeting until {store.clock(a.end)} · knocks go to Later</small></span>
      <button onClick={() => store.goToMeeting(a.key)}>Rejoin</button>
      <button className="end" title="You're no longer busy: knocks come through again" onClick={() => store.leaveMeetingForGood(a.key)}><Icon name="logout" /> Leave meeting</button>
      {a.adhoc && a.host && <button className="end" title="Close your room for everyone" onClick={() => store.endRoom(a.key)}>End room</button>}
    </div>;
  }
  const m = store.myMeeting, room = store.meetingRooms.find(r => r.id === me.instance);
  const others = (room?.members ?? []).filter(id => id !== me.id).map(id => store.users.get(id)).filter((u): u is ClientUser => !!u);
  const talking = store.inRoomVoice && !!voice && store.voiceOwner, onCall = room?.voice.length ?? 0, waiting = store.voiceWait === me.instance, full = onCall >= ROOM_VOICE_MAX && !talking;
  const meet = m?.adhoc && store.roomMeetLink?.instance === me.instance ? store.roomMeetLink.link : null;
  return <div className="desk-chip call-chip meeting-chip">
    <span>{m?.adhoc ? '🔒' : '📅'} <b>{m?.title ?? 'Meeting'}</b> <small>{m?.adhoc && m.from ? `· ${m.from.split(' ')[0]}'s room` : ''} · until {store.clock(room?.until ?? m?.end ?? 0)}{others.length ? ` · with ${store.names(others)}` : ' · waiting for the others'}</small></span>
    {m?.adhoc && <button onClick={() => store.openRoom(true)}>Invite</button>}
    {m?.adhoc && m.host && <button className="end" title="Close the room and send everyone back to the office"
      onClick={() => (!others.length || confirm(`End ${m.title} for everyone? ${store.names(others)} will go back to the office.`)) && store.endRoom(m.key)}>End room</button>}
    {talking ? <>
      <span className={`dot ${voiceState(voice) === 'live' ? 'live' : ''}`} title={`Voice in this room · ${voiceState(voice)}`} />
      <VoiceToggle kind="mic" voice={voice} disabled={!store.connected || !store.voiceOwner} />
      <VoiceToggle kind="headphones" voice={voice} disabled={!store.connected || !store.voiceOwner} />
      <IconButton icon="hand" label={me.hand ? 'Lower hand' : 'Raise hand'} aria-pressed={!!me.hand} className="vbtn chip" data-state={me.hand ? 'active' : 'ready'} onClick={() => store.setHand(!me.hand)} />
      <IconButton icon="disconnect" label="Leave voice" title="Stop hearing and talking in this room (the room stays open)" className="end" onClick={() => store.roomVoice(false)} />
    </> : waiting ? <button className="ghost" title="Voice is full: you'll join when a place frees up" onClick={() => store.roomVoice(false)}>In line · cancel</button>
      : <button disabled={!store.voiceOwner} title={full ? `Voice is full (${ROOM_VOICE_MAX}): you'll wait in line · or use Meet` : 'Talk with the others in this room'} onClick={() => store.roomVoice(true)}><Icon name="mic" /> Talk{onCall ? ` (${onCall}/${ROOM_VOICE_MAX})` : ''}</button>}
    {m?.adhoc && (meet ? <ExternalLink href={meetAs(meet, store.meetAccount)}>Join Meet</ExternalLink> : <button className="ghost" title="Make a Google Meet room for everyone in here" onClick={() => store.useRoomMeet()}>Use Meet</button>)}
    {m?.link && <ExternalLink href={meetAs(m.link, store.meetAccount)}>Join call</ExternalLink>}
    <button className="end" onClick={() => store.leaveMeeting()} aria-label="Leave room" title="Leave room"><Icon name="logout" /></button>
  </div>;
}

const musicTime = (ms: number) => { const s = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const musicPosition = (store: Store, state: JukeboxState) => jukeboxPosition(state, TRACK.get(state.track)?.duration ?? 0, store.now());

function JukeboxControls({ store, id, state, disabled }: { store: Store; id: string; state: JukeboxState; disabled: boolean }) {
  const paused = state.pausedAt !== null;
  return <>
    <button aria-label={paused ? 'Play' : 'Pause'} disabled={disabled}
      onClick={() => store.jukeboxAction(id, { action: paused ? 'play' : 'pause', playId: state.playId })}><Icon name={paused ? "play" : "pause"} /></button>
    <button aria-label="Skip" disabled={disabled} onClick={() => store.jukeboxAction(id, { action: 'skip', playId: state.playId })}><Icon name="skip" /></button>
  </>;
}

function NowPlayingChip({ store }: { store: Store }) {
  const o = MAP.objects.find(o => o.use?.kind === 'jukebox' && store.inJukeboxRoom(o.id));
  const state = o && store.jukebox[o.id], track = state && TRACK.get(state.track);
  if (!o || !state || !track) return null;
  const loading = store.soundscape?.jukeboxLoading(o.id) ?? false;
  const label = `♪ ${track.title} — ${track.artist} · ${loading ? 'Loading…' : `${musicTime(musicPosition(store, state))} / ${musicTime(track.duration)}`}`;
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
  const box = MAP.objects.find(o => o.id === id)?.use, library = tracksFor(box?.kind === 'jukebox' ? box.genres : undefined), genres = [...new Set(library.map(t => t.genre))];
  const mine = state?.queue.filter(e => e.by === store.me).length ?? 0;
  const last = state?.last && store.now() - state.last.at < 10_000 ? state.last : null;
  const close = () => store.closeJukebox();
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key !== 'Tab') return;
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)') ?? [])];
    const first = controls[0], end = controls[controls.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); end?.focus(); }
    else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); first?.focus(); }
  };
  return <div className="modal-backdrop" {...backdropClose(close)}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Jukebox" onKeyDown={onKey} className="meet-panel guided calendar-panel jukebox-panel">
      <div className="rooms-head"><span><Icon name="music" /> {box?.kind === 'jukebox' ? box.label.replace(/^./, c => c.toUpperCase()) : 'Jukebox'}</span><button className="ghost" aria-label="Close jukebox" onClick={close}><Icon name="close" /></button></div>
      {!known && <p role="status">Reconnecting…</p>}
      {!inside && <div className="jukebox-walk"><span>Walk into {room?.name ?? 'the room'} to pick music</span><button disabled={!known} onClick={() => store.walkToJukebox(id)}>Walk over</button></div>}
      <label className="volume-control jukebox-volume"><span>Volume for me</span>
        <input type="range" min="0" max="100" step="5" value={Math.round((prefs.jukeboxVolumes[id] ?? 1) * 100)} aria-label="Jukebox volume for me"
          onChange={e => { prefs.jukeboxVolumes[id] = Number(e.target.value) / 100; savePrefs(); }} /><output>{Math.round((prefs.jukeboxVolumes[id] ?? 1) * 100)}%</output>
      </label>
      <section>
        <h3>Now playing</h3>
        {state && track && <>
          <b>{track.title}</b><p className="small">{track.artist} · {track.genre}</p>
          <progress className="jukebox-progress" aria-label="Track progress" max={track.duration} value={position} />
          <div className="jukebox-times"><span role="status">{store.soundscape?.jukeboxLoading(id) ? 'Loading…' : musicTime(position)}</span><span>{musicTime(track.duration)}</span></div>
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
            {e.by === store.me && <button className="ghost" disabled={disabled} aria-label={`Remove ${t.title} from queue`} onClick={() => store.jukeboxAction(id, { action: 'unqueue', entry: e.id })}><Icon name="close" /></button>}
          </li>; })}
        </ol>
      </section>
      <section>
        <h3>Library</h3>
        {genres.map(genre => <div className="jukebox-genre" key={genre}>
          <h4>{genre}</h4><ul className="jukebox-tracks">
            {library.filter(t => t.genre === genre).map(t => {
              const reason = state?.track === t.id ? 'Playing now' : state?.queue.some(e => e.track === t.id) ? 'Already queued'
                : mine >= JUKEBOX_PER_PERSON ? `You have ${JUKEBOX_PER_PERSON} tracks queued` : (state?.queue.length ?? 0) >= JUKEBOX_QUEUE_MAX ? 'The queue is full' : undefined;
              return <li key={t.id}>
                <div><b>{t.title}</b><small>{t.artist} · {musicTime(t.duration)} · <ExternalLink href={t.page}>CC0</ExternalLink></small></div>
                <span title={reason}><button disabled={disabled || !!reason} title={reason} aria-label={`Queue ${t.title}`} onClick={() => store.jukeboxAction(id, { action: 'queue', track: t.id })}><Icon name="plus" /></button></span>
              </li>;
            })}
          </ul>
        </div>)}
      </section>
    </div>
  </div>;
}

function DungeonChip({ store }: { store: Store }) {
  const me = store.users.get(store.me);
  if (!me || !underground(me)) return null;
  const key = store.dungeon?.hasKey;
  return <div className="desk-chip call-chip meeting-chip dungeon-chip">
    <span>{key ? '🗝️' : '🕳'} <b>{key ? 'You have the key' : 'Underground'}</b> <small>· {key ? 'find the door' : 'find the key, then the door'}</small></span>
    <button className="end" onClick={() => store.dungeonLeave()}>Give up</button>
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
      <p className="hint">Drag furniture or rugs to move them. Arrows nudge, R turns a chair, Delete removes, Esc lets go. Everyone sees changes right away.</p>
      {sel && <section className="edit-sel">
        <h3>{sel.type ? objectName(sel.type) : 'Rug'}</h3>
        {sel.color && <>
          <div className="swatches">{RUG_COLORS.map(c => <button key={c} className={`swatch rug-${c}${sel.color === c ? ' on' : ''}`} title={c} aria-label={`${c} rug`}
            onClick={() => store.edit({ op: 'rug', id: sel.id, color: c })} />)}</div>
          <div className="swatches">{RUG_PATTERNS.map(p => <button key={p} className={`swatch pattern${(sel.pattern ?? 'diamond') === p ? ' on' : ''}`} title={p} aria-label={`${p} pattern`}
            onClick={() => store.edit({ op: 'rug', id: sel.id, pattern: p })}><ItemThumb assets={assets} frame={rugFrame({ color: sel.color ?? 'green', pattern: p }, 'c')} /></button>)}</div>
          <div className="rug-size">
            <span>{sel.w} × {sel.h}</span>
            <IconButton icon="shrink-horizontal" label="Narrower" onClick={() => resize(-1, 0)} disabled={sel.w <= RUG_MIN} />
            <IconButton icon="expand-horizontal" label="Wider" title="Wider (shift →)" onClick={() => resize(1, 0)} disabled={sel.w >= RUG_MAX} />
            <IconButton icon="shrink-vertical" label="Shorter" onClick={() => resize(0, -1)} disabled={sel.h <= RUG_MIN} />
            <IconButton icon="expand-vertical" label="Longer" title="Longer (shift ↓)" onClick={() => resize(0, 1)} disabled={sel.h >= RUG_MAX} />
          </div>
        </>}
        {sel.type && SEAT_TYPES.has(sel.type) && <button onClick={() => store.edit({ op: 'rotate', id: sel.id })} title="Turn (R)"><Icon name="rotate" /> Turn</button>}
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

/** What's in your pockets: hats to wear (one at a time) and whatever the bouncer sold you. */
function PocketsPanel({ store, me, assets, onClose }: { store: Store; me: ClientUser; assets: Assets | null; onClose: () => void }) {
  const wearing = String(effectOf(me.effects, 'hat')?.data?.style ?? '');
  const hats = store.items.flatMap(i => (hatOf(i) ? [hatOf(i)!] : []));
  const rest = new Map<string, number>();
  for (const i of store.items) if (!hatOf(i)) rest.set(i, (rest.get(i) ?? 0) + 1);
  const names: Record<string, [string, string]> = { drugs: ['💊', 'Drugs'] };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (!store.gameOpen && e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div className="edit-panel gm-panel">
      <div className="rooms-head"><span><Icon name="backpack" /> Pockets</span><button className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
      {!store.items.length && <p className="hint">Nothing yet. Hats hang on the stand in the Lobby.</p>}
      {hats.length > 0 && <>
        <h3>Hats</h3>
        <div className="palette">
          {hats.map(h => <button key={h} className={wearing === h ? 'on' : ''} onClick={() => store.setEffect(me.id, 'hat', wearing !== h, h)} title={wearing === h ? 'Take it off' : 'Wear it'}>
            <HatSprite assets={assets} style={h} /><span>{HAT_NAMES[h] ?? h}{wearing === h ? ' · on' : ''}</span>
          </button>)}
        </div>
      </>}
      {rest.size > 0 && <>
        <h3>Other</h3>
        <div className="palette">
          {[...rest].map(([i, n]) => <button key={i} disabled title={i === 'drugs' ? 'Rack it on a shelf in a Berghain stall' : i}><b className="gm-icon">{names[i]?.[0] ?? '📦'}</b><span>{names[i]?.[1] ?? i} × {n}</span></button>)}
        </div>
      </>}
    </div>
  );
}

/** Office admins as game masters: buffs, debuffs and hats on themselves or the person they clicked. */
function GmPanel({ store, picked, assets, onClose }: { store: Store; picked: string | null; assets: Assets | null; onClose: () => void }) {
  const [target, setTarget] = useState(picked ?? store.me);
  const [renaming, setRenaming] = useState('');
  useEffect(() => { if (picked) setTarget(picked); }, [picked]);
  useEffect(() => { setRenaming(''); }, [target]);
  const u = store.users.get(target) ?? store.users.get(store.me);
  const uid = u?.id;
  useEffect(() => { if (uid) store.requestGmItems(uid); }, [store, uid]);
  if (!u) return null;
  const pockets = store.gmItems.get(u.id);
  const people = [...store.users.values()].filter(p => p.presence !== 'offline').sort((a, b) => a.name.localeCompare(b.name));
  const now = store.now();
  const left = (until?: number) => until === undefined ? '' : ` ${Math.max(0, Math.ceil((until - now) / 1000))}s`;
  return (
    <div className="edit-panel gm-panel">
      <div className="rooms-head"><span><Icon name="sparkles" /> GM superpowers</span><button className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
      <label className="look-select">On<select value={u.id} onChange={e => setTarget(e.target.value)}>
        {people.map(p => <option value={p.id} key={p.id}>{p.id === store.me ? `${p.name} (you)` : p.name}</option>)}
      </select></label>
      <p className="hint">Click someone on the floor to aim at them.</p>
      {u.id !== store.me && <button className="ghost reset" onClick={() => store.teleport(u.id)}><Icon name="portal" /> Teleport to {u.name.split(' ')[0]}</button>}
      {!u.bot && <form className="rug-size" onSubmit={e => { e.preventDefault(); const v = renaming.trim(); if (v && v !== u.name) { store.rename(u.id, v); setRenaming(''); } }}>
        <input value={renaming} maxLength={24} onChange={e => setRenaming(e.target.value)} placeholder={`Rename ${u.name}`} aria-label={`New name for ${u.name}`} />
        <button type="submit" disabled={!renaming.trim() || renaming.trim() === u.name}><Icon name="edit" /> Rename</button>
      </form>}
      <div className="palette">
        {Object.entries(EFFECTS).filter(([k]) => k !== 'hat').map(([k, r]) => {
          const on = effectOf(u.effects, k);
          return <button key={k} className={on ? 'on' : ''} onClick={() => store.setEffect(u.id, k, !on)} title={on ? `Take ${r.label.toLowerCase()} off` : r.label}>
            <b className="gm-icon">{r.icon}</b><span>{r.label}{on ? left(on.until) : ''}</span>
          </button>;
        })}
      </div>
      <h3>Gift a hat <small>Goes in {u.id === store.me ? 'your' : `${u.name.split(' ')[0]}'s`} pockets and onto the head; click the worn one to take it off.</small></h3>
      <div className="palette">
        {ALL_HATS.map(h => {
          const on = effectOf(u.effects, 'hat')?.data?.style === h;
          return <button key={h} className={on ? 'on' : ''} onClick={() => on ? store.setEffect(u.id, 'hat', false) : store.giftHat(u.id, h)}><HatSprite assets={assets} style={h} /><span>{HAT_NAMES[h]}</span></button>;
        })}
      </div>
      <h3>Pockets</h3>
      <p className="hint">{!pockets ? '…' : pockets.length === 0 ? 'empty' : pockets.map(i => { const h = hatOf(i); return h ? `${HAT_NAMES[h] ?? h} (hat)` : ITEMS.get(i)?.label ?? i; }).join(', ')}</p>
      {u.effects.length > 0 && <button className="ghost reset" onClick={() => u.effects.forEach(e => store.setEffect(u.id, e.kind, false))}>Clear everything on {u.name.split(' ')[0]}</button>}
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

/** A hat as it looks on a head, from the world atlas (`hat_<style>`), scaled up and centered. */
function HatSprite({ assets, style, scale = 2 }: { assets: Assets | null; style: string; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const name = `hat_${style}`;
  useEffect(() => {
    const c = ref.current, f = assets?.atlas.frames[name]; if (!c || !assets) return;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, c.width, c.height);
    if (f) ctx.drawImage(assets.world, f.x, f.y, f.w, f.h, Math.floor((c.width - f.w * scale) / 2), Math.floor((c.height - f.h * scale) / 2), f.w * scale, f.h * scale);
  }, [assets, name, scale]);
  return <canvas ref={ref} width={16 * scale} height={14 * scale} className="hat-sprite" aria-hidden="true" />;
}

/** The Lobby notice board: the latest images shared in the team Slack channel. */
function EmployeePanel({ store }: { store: Store }) {
  const close = () => store.closeEmployeeBoard();
  return (
    <div className="modal-backdrop" {...backdropClose(close)}>
      <div className="meet-panel guided calendar-panel employee-panel" role="dialog" aria-label="Employee Of the Month">
        <div className="rooms-head"><span>🖼️ Employee Of the Month</span><button type="button" className="ghost" aria-label="Close" onClick={close}><Icon name="close" /></button></div>
        <p className="small muted">Employees of the month · latest pictures from <a className="employee-source-link" href="https://t1a.slack.com/archives/C05FHR09MMMM" target="_blank" rel="noreferrer">#cat_fridays_and_dog_saturdays</a></p>
        {store.slackImagesLoading && <p className="muted">Loading images…</p>}
        {store.slackImagesError && <div className="employee-error"><p>Couldn’t load images from Slack.</p><small>{store.slackImagesError}</small><button className="ghost" onClick={() => void store.loadSlackImages()}>Retry</button></div>}
        {!store.slackImagesLoading && !store.slackImagesError && store.slackImages.length === 0 && <p className="muted">There are no images in this channel yet.</p>}
        <div className="employee-gallery">
          {store.slackImages.map(image => <figure key={image.id}>
            <img src={image.url} alt={image.name} loading="lazy" />
          </figure>)}
        </div>
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
    <div className="modal-backdrop" {...backdropClose(() => store.closeMeetings())}>
      <div className="meet-panel guided calendar-panel">
        <div className="rooms-head"><span>🚪 Meetings on now</span><button aria-label="Close" type="button" className="ghost" onClick={() => store.closeMeetings()}><Icon name="close" /></button></div>
        {!store.meetingRooms.length && !goable.length && <p className="muted small">No meetings in their rooms right now. When a calendar meeting starts, its people get a Go button.</p>}
        <ul className="meeting-list">
          {store.meetingRooms.map(r => {
            const a = mine.get(r.id), people = r.members.map(id => store.users.get(id)).filter((u): u is ClientUser => !!u);
            return <li key={r.id}>
              <span><b>{a?.title ?? 'A meeting'}</b> <small className="muted">until {store.clock(r.until)}</small><br /><small>{store.names(people)}</small></span>
              {a && me?.instance !== r.id && <button onClick={() => store.goToMeeting(a.key)}>Go</button>}
              {a?.adhoc && a.host && <button className="ghost" title="Close your room for everyone" onClick={() => store.endRoom(a.key)}>End</button>}
            </li>;
          })}
          {goable.map(a => <li key={a.key}>
            <span><b>{a.title}</b> <small className="muted">{store.clock(a.start)}–{store.clock(a.end)}</small><br /><small>nobody's in yet</small></span>
            <button onClick={() => store.goToMeeting(a.key)}>Go</button>
            {a.adhoc && a.host && <button className="ghost" title="Close your room" onClick={() => store.endRoom(a.key)}>End</button>}
          </li>)}
        </ul>
      </div>
    </div>
  );
}

/** Where our people are: [region, [city, IANA zone][]]. Edit here; daylight saving comes from the zone names. */
const CLOCK_REGIONS: [string, [string, string][]][] = [
  ['USA', [['New York', 'America/New_York'], ['Chicago', 'America/Chicago'], ['Denver', 'America/Denver'], ['Los Angeles', 'America/Los_Angeles']]],
  ['Canada', [['Toronto', 'America/Toronto'], ['Vancouver', 'America/Vancouver']]],
  ['West Europe', [['London', 'Europe/London'], ['Paris', 'Europe/Paris'], ['Madrid', 'Europe/Madrid']]],
  ['East Europe', [['Warsaw', 'Europe/Warsaw'], ['Kyiv', 'Europe/Kyiv'], ['Bucharest', 'Europe/Bucharest']]],
];

/** The Lobby clock: the time in each city, a day marker when it isn't your date, your own zone highlighted. */
function ClockPanel({ store }: { store: Store }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(i); }, []);
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // yyyy-mm-dd
  const myDay = day(mine);
  const offset = (tz: string) => offsetOf(tz, mine, now);
  return (
    <div className="modal-backdrop" {...backdropClose(() => store.closeClock())}>
      <div className="meet-panel guided">
        <div className="rooms-head"><span><Icon name="clock" /> Our time zones</span><button aria-label="Close" type="button" className="ghost" onClick={() => store.closeClock()}><Icon name="close" /></button></div>
        {CLOCK_REGIONS.map(([region, cities]) => (
          <div key={region}>
            <p className="small muted"><b>{region}</b></p>
            <ul className="meeting-list">
              {cities.map(([city, tz]) => {
                const d = day(tz), here = offset(tz) === 0;
                return (
                  <li key={tz} style={here ? { fontWeight: 600 } : undefined}>
                    <span>{city}{here && <small className="muted"> · your time</small>}</span>
                    <span>{new Intl.DateTimeFormat([], { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(now)}{d !== myDay && <small className="muted"> · {d > myDay ? 'tomorrow' : 'yesterday'}</small>}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
/** The vault door: where the team's vault lives, and a link that opens it in a new tab. */
function LinkPanel({ store }: { store: Store }) {
  const { label, url } = store.linkOpen!;
  const host = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <div className="modal-backdrop" {...backdropClose(() => store.closeLink())}>
      <div className="meet-panel guided">
        <div className="rooms-head"><span><Icon name="lock" /> Vault 13</span><button aria-label="Close" type="button" className="ghost" onClick={() => store.closeLink()}><Icon name="close" /></button></div>
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
    <div className="modal-backdrop" {...backdropClose(() => store.closeCalendar())}>
      <div className="meet-panel guided calendar-panel">
        <div className="rooms-head">
          <span>📅 {account ? `Calendar · ${account}` : 'Your calendar'}</span>
          <button aria-label="Close" type="button" className="ghost" onClick={() => store.closeCalendar()}><Icon name="close" /></button>
        </div>
        {body}
        <div className="row"><ExternalLink href={calendarHome}>Open Google Calendar</ExternalLink></div>
      </div>
    </div>
  );
}

/** Phones and small windows: the floor's controls within thumb reach. */
function Dock({ store, voice, engine, roomsOpen, onRooms }: { store: Store; voice: Voice | null; engine: Engine | null; roomsOpen: boolean; onRooms: () => void }) {
  const z = engine?.zoom;
  const total = [...store.unread.values()].reduce((a, b) => a + b, 0);
  const chatWith = [...store.unread.keys()][0] ?? [...store.chats.keys()].at(-1);
  return (
    <nav className="dock" aria-label="Floor">
      <button className={roomsOpen ? 'on' : ''} aria-pressed={roomsOpen} onClick={onRooms}><Icon name="users" /><small>People</small></button>
      <button className={z?.overview ? 'on' : ''} aria-pressed={!!z?.overview} onClick={() => engine?.toggleOverview()}>
        <Icon name="map" /><small>{z?.overview ? 'Back' : 'Floor'}</small></button>
      <button onClick={() => engine?.recenter()}><Icon name="locate" /><small>Me</small></button>
      <button onClick={() => (chatWith ? store.openChat(chatWith) : !roomsOpen && onRooms())} title={chatWith ? undefined : 'Pick someone in People to message'}>
        <Icon name="message" />{total > 0 && <b className="badge">{total}</b>}<small>Chat</small></button>
      {store.later.length > 0 && <button onClick={() => store.openLater()} title="Knocks you missed"><Icon name="bell" /><b className="badge">{store.later.length}</b><small>Later</small></button>}
      <VoiceIcons store={store} voice={voice} dock />
    </nav>
  );
}

/** 💬 N in the top bar while messages are unread; opens the oldest unread chat (the Rooms panel is often closed). */
function UnreadButton({ store }: { store: Store }) {
  const senders = [...store.unread.keys()]; // insertion order = oldest unread first
  const total = [...store.unread.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  return (
    <button className="chip unread-btn" onClick={() => store.openChat(senders[0])}
      title={`Unread from ${store.names(senders.map(id => store.users.get(id)!).filter(Boolean))}`} aria-label={`${total} unread messages`}><Icon name="message" />{total}</button>
  );
}

/** 🔔 N in the top bar while knocks sit in your Later list. */
function LaterButton({ store }: { store: Store }) {
  if (!store.later.length) return null;
  return <button className="chip unread-btn later-btn" onClick={() => store.openLater()} title="Knocks you missed" aria-label={`${store.later.length} missed knocks`}><Icon name="bell" />{store.later.length}</button>;
}

const ago = (at: number) => { const m = Math.floor((Date.now() - at) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`; };
function LaterPanel({ store }: { store: Store }) {
  return (
    <div className="modal-backdrop" {...backdropClose(() => store.closeLater())}>
      <div className="meet-panel guided later-panel">
        <div className="rooms-head">
          <span>🔔 Missed knocks</span>
          <button aria-label="Close" type="button" className="ghost" onClick={() => store.closeLater()}><Icon name="close" /></button>
        </div>
        <ul className="later-list">
          {store.later.map(i => (
            <li key={i.id}>
              <span className="txt"><b>{store.name(i.fromId)}</b> · {ago(i.at)} · {i.why}</span>
              <button onClick={() => store.laterKnockBack(i.fromId)}>Knock back</button>
              <button className="ghost x" aria-label="Dismiss" onClick={() => store.laterDismiss(i.id)}><Icon name="close" /></button>
            </li>
          ))}
        </ul>
        <div className="row"><button className="ghost" onClick={() => store.laterClear()}>Clear all</button></div>
      </div>
    </div>
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
      <button className="chip ghost" onClick={() => setOpen(!open)} title="Install The Deck in your menu bar">Mac app</button>
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

/** Props for a modal backdrop that closes on a tap on the backdrop itself: one that both started and ended there.
 *  A click that only *ends* on it (iOS sends a compatibility click after the canvas tap that opened the panel) is ignored. */
let backdropArmed = false; // outside the closure: a re-render between pointerdown and click (the store ticks) mustn't lose it
function backdropClose(close: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => { backdropArmed = e.target === e.currentTarget; },
    onClick: (e: React.MouseEvent) => { if (backdropArmed && e.target === e.currentTarget) close(); backdropArmed = false; },
  };
}



/** −, + and ⤢ in the floor's bottom-right corner. */
function ZoomCluster({ engine }: { engine: Engine }) {
  const z = engine.zoom;
  return <div className="zoom" role="group" aria-label="Zoom">
    <button className="chip" onClick={() => engine.zoomOut()} disabled={!z.canOut} title="Zoom out (−, ⌘ scroll or pinch)" aria-label="Zoom out"><Icon name="minus" /></button>
    <button className="chip" onClick={() => engine.zoomIn()} disabled={!z.canIn} title="Zoom in (+, ⌘ scroll or pinch)" aria-label="Zoom in"><Icon name="plus" /></button>
    <button onClick={() => engine.toggleOverview()} className={`chip${z.overview ? ' on' : ''}`} aria-pressed={z.overview}
      aria-label={z.overview ? 'Back to previous view' : 'Whole floor'} title={z.overview ? 'Back to where you were (M)' : 'Whole floor (M)'}><Icon name="expand" /></button>
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
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'achievement' ? 'status' : undefined}>
          {t.kind === 'knock_in' && <span className="bang">!</span>}
          {t.kind === 'achievement' && t.achievementId ? <>
            <AchievementBadge a={ACHIEVEMENTS.find(a => a.id === t.achievementId)!} unlocked />
            <span className="txt"><span className="achievement-unlocked-label">ACHIEVEMENT UNLOCKED</span><strong className="achievement-toast-title">{ACHIEVEMENTS.find(a => a.id === t.achievementId)!.title}</strong><AchievementRarity id={t.achievementId} store={store} unlocked /></span>
            <button onClick={() => { store.openAchievements(true, t.achievementId); store.dismiss(t.id); }}>View</button>
          </> : <span className="txt">{t.text}{t.hint && <small className="hint">{t.hint}</small>}</span>}
          {t.kind === 'knock_in' && t.knockId && <>
            <button onClick={() => store.replyKnock(t.knockId!, 'accept')}>Accept</button>
            <button className="ghost" onClick={() => store.replyKnock(t.knockId!, 'later')}>Later</button>
          </>}
          {t.kind === 'knock_out' && t.knockId && <button className="ghost" onClick={() => store.cancelKnock(t.knockId!)}>Cancel</button>}
          {t.kind === 'knock_again' && t.userId && <button onClick={() => { store.dismiss(t.id); store.knock(t.userId!); }}>
            {t.text.startsWith('Missed') ? 'Knock back' : 'Knock again'}
          </button>}
          {t.kind === 'call_moved' && t.roomId && <button onClick={() => { store.joinRoom(t.roomId!); store.dismiss(t.id); }}>Join them</button>}
          {t.actions?.map(a => <button key={a.label} className={a.ghost ? 'ghost' : ''} onClick={() => { store.dismiss(t.id); a.run(); }}>{a.label}</button>)}
          {t.kind === 'chat' && t.userId && <button onClick={() => store.openChat(t.userId!)}>Reply</button>}
          {t.kind === 'meeting' && t.meetingKey && <button onClick={() => store.goToMeeting(t.meetingKey!)}>Go</button>}
          {t.kind === 'meeting' && t.link && <ExternalLink href={meetAs(t.link, store.meetAccount)}>Join call</ExternalLink>}
          {t.kind === 'link' && t.link && <ExternalLink href={meetAs(t.link, store.meetAccount)} onOpen={() => store.dismiss(t.id)}>Join Meet</ExternalLink>}
          {t.kind !== 'knock_in' && t.kind !== 'knock_out' && <IconButton icon="close" label="Close" className="ghost x" onClick={() => store.dismiss(t.id)} />}
        </div>
      ))}
    </div>
  );
}

type WheelItem = { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; title?: string; active?: boolean; hat?: string }; // hat: draw that hat's sprite instead of the icon

/** Click a person or a thing: a ring of actions around it, following it as it moves. */
function ActionWheel({ store, engine, pick, assets, onPerson, onClose }: { store: Store; engine: Engine; pick: Pick; assets: Assets | null; onPerson: (at: PersonAnchor) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const isMe = pick.kind === 'user' && pick.id === store.me;
  const [emoji, setEmoji] = useState(isMe);
  // the wheel stays where it opened (a moving target is hard to hit); the floor ring shows who it's for
  const [at] = useState(() => engine.anchor(pick));
  useEffect(() => {
    let raf = 0;
    const tick = () => { if (!engine.anchor(pick)) return onClose(); raf = requestAnimationFrame(tick); };
    tick();
    const key = (e: KeyboardEvent) => { if (!store.gameOpen && e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', key); };
  }, [engine, pick]);

  const me = store.users.get(store.me);
  const act = (fn: () => void) => () => { fn(); onClose(); };
  let title = '', items: WheelItem[] = [];
  if (pick.kind === 'user') {
    const u = store.users.get(pick.id);
    if (!u || !onMap(u)) return null;
    title = isMe ? 'You' : u.name.split(' ')[0];
    if (u.presence === 'offline') {
      items = [{ icon: '💬', label: 'Message', onClick: act(() => store.openChat(u.id)) }];
    } else if (emoji) {
      items = REACTIONS.map(e => ({ icon: e, label: '', onClick: act(() => store.react(u.id, e)) }));
      const held = isMe ? heldItem(me?.holding) : undefined;
      if (isMe && me?.eating) items.push({ icon: <Icon name={me.eating.open ? "bell" : "message"} off={me.eating.open} />, label: me.eating.open ? 'Quiet' : 'Chat', title: me.eating.open ? 'Go quiet: leave the table\'s talk; knocks go to Later' : 'Chat: join the talk of everyone chatting at this table (you start muted)', onClick: act(() => store.lunchOpen(!me.eating!.open)) });
      if (!isMe) items.push({ icon: <Icon name="arrow-left" />, label: 'Back', onClick: () => setEmoji(false) });
      else if (held && me?.holding && DRINKS[me.holding]) { if (!me.sipping) items.push({ icon: held.icon, label: 'Drink', title: `Drink your ${held.label.toLowerCase()}`, onClick: act(() => store.drink()) }); }
      else if (held?.empty) items.push({ icon: <span style={{ opacity: 0.45 }}>{held.icon}</span>, label: 'Drop', title: `Drop your ${held.label.toLowerCase()} on the floor (or click a table to put it down)`, onClick: act(() => store.drop()) });
      else if (held) items.push({ icon: held.icon, label: 'Finish', title: `Finish your ${held.label.toLowerCase()}`, onClick: act(() => store.drop()) });
      if (isMe && me?.following) items.push({ icon: <Icon name="stop" />, label: 'Stop following', onClick: act(() => store.follow(null)) });
    } else {
      const away = goingOut(u);
      const dungeon = store.dungeonReason(u);
      const following = me?.following === u.id, noKnock = store.knockReason(u);
      items = [
        { icon: <Icon name="knock" />, label: 'Knock', onClick: act(() => store.knock(u.id)), disabled: !!noKnock,
          title: noKnock ?? 'Knock for a voice call' },
        { icon: <Icon name="follow" />, label: following ? 'Unfollow' : 'Follow', active: following, onClick: act(() => store.follow(following ? null : u.id)), disabled: away || !!dungeon, title: dungeon ?? undefined },
        { icon: <Icon name="smile" />, label: 'React', onClick: () => setEmoji(true) },
        { icon: <Icon name="message" />, label: 'Message', onClick: act(() => store.openChat(u.id)) },
      ];
      if (isMe && (store.dancing || (store.roomOf(u)?.id === DANCE_ROOM && !u.instance))) items.push({ icon: '💃', label: store.dancing ? 'Stop dancing' : 'Dance', onClick: act(() => store.dance()) });
      if (me?.callId && me.callId === u.callId) items.push({ icon: <Icon name="volume" />, label: 'Volume', onClick: act(() => { if (at) onPerson({ id: u.id, x, y }); }) });
      if (!isMe && !away) { const why = store.roomReason(u); if (!why) items.push({ icon: <Icon name="lock" />, label: 'Private room', title: `Take ${u.name.split(' ')[0]} to a private room`, onClick: act(() => store.createRoom([u.id])) }); }
      if (store.admin && me && !me.instance && !u.instance && !away) items.push({ icon: <Icon name="portal" />, label: 'Teleport', title: `Step through a portal to ${u.name.split(' ')[0]}`, onClick: act(() => store.teleport(u.id)) });
      if (!isMe && me && effectOf(me.effects, 'vampire')) { const turned = !!effectOf(u.effects, 'vampire');
        items.push({ icon: '🧛', label: 'Bite', disabled: turned || away || !!dungeon, title: dungeon ?? (turned ? `${u.name.split(' ')[0]} is already a vampire` : `Bite ${u.name.split(' ')[0]}: a vampire for 2 minutes`), onClick: act(() => store.bite(u.id)) }); }
      const held = me?.holding && !isEmpty(me.holding) ? ITEMS.get(me.holding) : undefined; // an empty cup isn't a present
      if (held) items.push({ icon: held.icon, label: 'Give', disabled: !!u.holding || away || !!dungeon,
        title: dungeon ?? (u.holding ? `${u.name.split(' ')[0]}'s hands are full` : `Give ${u.name.split(' ')[0]} your ${held.label.toLowerCase()}`),
        onClick: act(() => store.give(u.id)) });
    }
  } else {
    const o = MAP.objects.find(o => o.id === pick.id);
    const meal = o?.type === 'chair' && me?.holding ? ITEMS.get(me.holding) : undefined;
    if (o && meal && picnicSeat(MAP, o)) { // a chair at a picnic table, food in hand
      title = `${meal.icon} Eat lunch here`;
      items = [{ icon: <Icon name="bell" off />, label: 'Eat quietly', title: 'Eat here; knocks go to Later', onClick: act(() => store.lunch({ x: o.x, y: o.y }, false)) },
        { icon: <Icon name="message" />, label: 'Eat & chat', title: 'Eat here and join the table\'s talk (you start muted)', onClick: act(() => store.lunch({ x: o.x, y: o.y }, true)) }];
    } else if (!o || !routes(o.use, 'wheel')) return null; // the other kinds act on the click (e.onPick above)
    else if (o.use.kind === 'toilet') {
      const s = store.toilets[o.id], full = toiletFull(s), inside = !!s?.in.includes(store.me), queued = s?.queue.indexOf(store.me) ?? -1;
      title = full ? 'Toilet · out of order' : inside ? `Toilet · ${s!.in.length}/${TOILET_CAPACITY} inside` : queued >= 0 ? `Toilet · #${queued + 1} in line` : s?.in.length ? `Toilet · ${s.in.length}/${TOILET_CAPACITY} inside` : 'Toilet';
      if (inside) {
        const has = store.items.includes(TOILET_SHELF_ITEM), company = s!.in.length > 1;
        items = [{ icon: '💳', label: 'Rack', disabled: !has || !company || s!.shelf >= TOILET_SHELF_MAX,
          title: !has ? 'Rack a line · you need drugs (ask the bouncer)' : !company ? 'Rack a line · not on your own, wait for company' : s!.shelf >= TOILET_SHELF_MAX ? 'Rack a line · the shelf is full' : `Rack a line on the shelf (${s!.shelf} there)`,
          onClick: act(() => store.rackLine(o.id)) },
          { icon: '👃', label: 'Sniff', disabled: !s!.shelf, title: s!.shelf ? `Sniff a line · ${s!.shelf} on the shelf` : 'Sniff · nothing on the shelf', onClick: act(() => store.sniffLine(o.id)) },
          { icon: <Icon name="logout" />, label: 'Leave', onClick: act(() => store.moveTo({ x: o.x, y: o.y - 2 })) }];
      } else {
        const crowded = (s?.in.length ?? 0) >= TOILET_CAPACITY || !!s?.queue.length;
        items = [{ icon: '🚽', label: crowded ? 'Line up' : 'Use', disabled: full || queued >= 0, title: full ? 'Full — it drains in a few minutes' : queued >= 0 ? "You're in line" : crowded ? `Full house — ${s!.queue.length} in line` : `Go in for ${TOILET_USE_MS / 1000} s`, onClick: act(() => store.use(o.id)) }];
      }
    } else if (o.use.kind === 'dealer') {
      if (o.type === 'bouncer') {
        const n = store.items.filter(i => i === 'drugs').length;
        title = n ? `Bouncer · ${n} 💊 in your pockets` : 'Bouncer';
        items = [{ icon: '💊', label: 'Score', title: 'Ask the bouncer for something', onClick: act(() => store.use(o.id, 'drugs')) }];
      } else {
        title = 'Hat stand';
        items = o.use.items.map(it => { const h = hatOf(it) ?? it, have = store.items.includes(it);
          return { icon: '🎩', hat: h, label: (HAT_NAMES[h] ?? h).replace(/ hat$/, ''), disabled: have, title: have ? `${HAT_NAMES[h]} · already in your pockets` : `Take the ${(HAT_NAMES[h] ?? h).toLowerCase()}`, onClick: act(() => store.use(o.id, it)) }; });
      }
    } else if (o.use.kind === 'toggle') {
      const on = store.objects[o.id]?.on ?? o.on ?? true;
      title = o.use.label[0].toUpperCase() + o.use.label.slice(1);
      items = [{ icon: <Icon name="light" off={on} />, label: on ? 'Turn off' : 'Turn on', onClick: act(() => store.use(o.id)) }];
    } else if (o.use.kind === 'take') {
      title = o.type === 'coffee_machine' ? 'Coffee machine' : o.type === 'fridge' ? 'Fridge' : o.type === 'food_cart' ? 'Food cart' : o.type === 'beach_bar' ? 'Beach bar' : o.type;
      items = o.use.items.map(i => ({ icon: i.icon, label: i.label, title: REFRESHMENT_HINTS[i.id] ?? i.label, onClick: act(() => store.use(o.id, i.id)) }));
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
            <span className="ic">{it.hat ? <HatSprite assets={assets} style={it.hat} scale={1} /> : it.icon}</span>
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
        <button aria-label="Close" className="ghost" onClick={() => store.closeChat()} title="Close"><Icon name="close" /></button>
      </div>
      <div className="chat-list" ref={listRef}>
        {!msgs.length && <p className="muted">Say hi to {other?.name.split(' ')[0] ?? 'them'} 👋{other?.presence === 'offline' ? ' They\'ll see it when they\'re back.' : ''}</p>}
        {msgs.map(m => (
          <div key={m.id} className={`msg${m.fromId === store.me ? ' mine' : ''}`}>
            <span>{slurBy(store.users.get(m.fromId)?.effects, m.text, m.at, m.id)}</span><small>{time(m.at)}</small>
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(); }}>
        <input autoFocus value={draft} maxLength={MAX_CHAT_LEN} placeholder="Message…" onChange={e => setDraft(e.target.value)} />
        <button disabled={!draft.trim()} aria-label="Send message" title="Send message"><Icon name="send" /></button>
      </form>
    </aside>
  );
}
