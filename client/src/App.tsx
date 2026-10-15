import { INSTRUMENTS, DRUM_PADS, VELOCITIES, VELOCITY_START, keyNote, noteName, type InstrumentKind } from '../../shared/instruments';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadAssets, type Assets } from './assets';
import { Engine, type Pick } from './engine';
import { Voice } from './voice';
import { ArcadeOverlay, RecordsPopover } from './park/ArcadeOverlay';
import { Soundscape } from './soundscape';
import { needsGesture, resume } from './audio';
import { prefs, savePrefs, type Category } from './prefs';
import { ITEMS, MAP, Store, type ClientUser } from './net';
import { inNativeApp, syncNative } from './native';
import { LiveChip, PresentPanel, SlideOverlay, WatchPrompt } from './Presentation';
import { LibraryPanel, ReadingOverlay } from './Library';
import { ACHIEVEMENTS, underground, dayNumber, JUKEBOX_PER_PERSON, JUKEBOX_QUEUE_MAX, MAX_CHAT_LEN, MEET_LINK_RE, meetAs, normalizeMeetLink, kindName, PLANT_DIES_DAYS, PLANT_KINDS, PLANT_REVEAL, PLANT_STAGES, plantDead, plantName, REACTIONS, TOILET_CAPACITY, TOILET_SHELF_ITEM, TOILET_SHELF_MAX, TOILET_USE_MS, toiletFull, type JukeboxState, type Plant } from '../../shared/protocol';
import { GENRES, jukeboxPosition, TRACK, TRACKS } from '../../shared/music';
import { ALL_HATS, DANCE_ROOM, EFFECTS, HAT_NAMES, JUDGE_HATS, effectOf, hatItem, hatOf } from '../../shared/effects';
import { FIXED_TYPES, KEEP_TYPES, objectName, RUG_COLORS, RUG_MAX, RUG_MIN, routes, seatAt } from '../../shared/map';
import { LUNCH_MS, picnicSeat } from '../../shared/lunch';

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
  const chromeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (chromeRef.current) chromeRef.current.inert = store.gameOpen; }, [store.gameOpen]);
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
  const [gmOpen, setGmOpen] = useState(false);
  const [pocketsOpen, setPocketsOpen] = useState(false);

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
      if (use?.kind === 'instrument' && p) { setPick(null); return store.playInstrument(p.id); }
      if (use?.kind === 'arcade' && p) { setPick(null); return store.use(p.id); }
      if (use?.kind === 'dance' && p) { setPick(null); return store.dance(p.id); }
      if (use?.kind === 'records') { setPick(null); return store.openRecords(); }
      if (use?.kind === 'jukebox' && p) { setPick(null); return store.openJukebox(p.id); }
      if (use?.kind === 'bell' && p) { setPick(null); return store.ring(p.id); }
      if (use?.kind === 'library') { setPick(null); return store.openLibrary(); }
      if (use?.kind === 'calendar') { setPick(null); return store.openCalendar(); }
      if (use?.kind === 'clock') { setPick(null); return store.openClock(); }
      if (use?.kind === 'meetings') { setPick(null); return store.openMeetings(); }
      if (use?.kind === 'achievements') { setPick(null); return store.openAchievements(); }
      if (use?.kind === 'presentation' && p) { setPick(null); return store.openPresent(p.id); }
      if (use?.kind === 'link') { setPick(null); return store.openLink(use); } // a panel, like the calendar: its link is a real tap
      setPick(cur => (p && cur?.kind === p.kind && cur.id === p.id ? null : p)); // same target again: close
    };
    e.onZoom = () => tick(n => n + 1);
    e.onEditChange = () => { setEditing(e.editing); tick(n => n + 1); };
    engineRef.current = e; setEngine(e);
    if (import.meta.env.DEV) Object.assign(window, { __deck: { store, engine: e } });
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
  const myRoom = me ? store.roomOf(me) : undefined;
  useEffect(() => { if (me && !me.lookSet) setShowAppearance(true); }, [me?.id, me?.lookSet]);

  return (
    <div className="office">
      <div className="office-chrome" ref={chromeRef}>
      <TopBar store={store} voice={voice} roomName={myRoom?.name} onToggleRooms={() => setShowRooms(s => !s)} onLogout={onLogout}
        onToggleMeet={() => setShowMeet(s => !s)} onToggleAppearance={() => setShowAppearance(s => me?.lookSet ? !s : true)}
        editing={editing} onToggleEdit={() => setEditing(e => !e)} gmOpen={gmOpen} onToggleGm={() => setGmOpen(o => !o)}
        pocketsOpen={pocketsOpen} onTogglePockets={() => setPocketsOpen(o => !o)} />
      <div className={`stage${editing && store.admin && !down && engine ? ' editing' : ''}`}>
        <div className="canvas-wrap"><canvas ref={canvasRef} /></div>
        {engine && <ZoomCluster engine={engine} />}
        {!assets && <div className="loading">Unlocking the door…</div>}
        {!store.connected && assets && <div className="loading small">Reconnecting…</div>}
        {store.presentation && store.inPresentationRoom() && !store.slidesHidden && <SlideOverlay store={store} />}
        {showRooms && <RoomList store={store} onPerson={openPerson} onClose={() => setShowRooms(false)}
          onPick={id => { engineRef.current?.walkToUser(id); if (compact()) setShowRooms(false); }}
          onRoom={id => { engineRef.current?.walkToRoom(id); if (compact()) setShowRooms(false); }} />}
        {editing && store.admin && !down && engine && <EditPanel store={store} engine={engine} assets={assets} onDone={() => setEditing(false)} />}
        {gmOpen && store.admin && !editing && <GmPanel store={store} picked={pick?.kind === 'user' ? pick.id : null} assets={assets} onClose={() => setGmOpen(false)} />}
        {pocketsOpen && me && <PocketsPanel store={store} me={me} assets={assets} onClose={() => setPocketsOpen(false)} />}
        {store.calendarOpen && <CalendarPanel store={store} />}
        {store.meetingsOpen && <MeetingsPanel store={store} />}
        {store.libraryOpen && <LibraryPanel store={store} />}
        {me?.reading && <ReadingOverlay key={me.reading} store={store} articleId={me.reading} />}
        {store.jukeboxOpen && <JukeboxPanel key={store.jukeboxOpen} store={store} id={store.jukeboxOpen} />}
        {store.recordsOpen && <RecordsPopover store={store} />}
        {store.linkOpen && <LinkPanel store={store} />}
        {store.presentOpen && <PresentPanel key={store.presentOpen} store={store} id={store.presentOpen} />}
        {store.clockOpen && <ClockPanel store={store} />}
        {store.achievementsOpen && me && <AchievementsPanel store={store} me={me} assets={assets} />}
        {(showMeet || store.pendingKnock) && <MeetSetup key={store.pendingKnock ?? 'panel'} store={store} onClose={() => setShowMeet(false)} />}
        {showAppearance && me && <AppearanceMenu key={me.id} look={me.look} assets={assets} firstTime={!me.lookSet} store={store}
          onSave={(look) => { store.setLook(look); setShowAppearance(false); }} onClose={() => setShowAppearance(false)} />}
        <div className="chips">
          <MeetingChip store={store} />
          <LiveChip store={store} onGo={room => engineRef.current?.walkToRoom(room)} />
          <WatchPrompt store={store} />
          <NowPlayingChip store={store} />
          <DungeonChip store={store} />
          {me?.callId && !store.roomCallOf(me) && store.voiceOwner && <CallChip store={store} voice={voice} />}
          <DeskChip store={store} />
        </div>
        <Toasts store={store} />
        {pick && engineRef.current && <ActionWheel key={`${pick.kind}:${pick.id}`} store={store} engine={engineRef.current} pick={pick} assets={assets} onPerson={openPerson} onClose={() => setPick(null)} />}
        <div className="self-stack">
          {store.chatWith && <ChatPanel key={store.chatWith} store={store} withId={store.chatWith} />}
        </div>
        {personMenu && <PersonMenu key={personMenu.id} store={store} at={personMenu} onClose={() => setPersonMenu(null)} />}
        {store.seat && <InstrumentPanel key={store.seat} store={store} id={store.seat}
          dialogOpen={!!(showAppearance || showMeet || store.pendingKnock || store.calendarOpen || store.meetingsOpen || store.clockOpen || store.jukeboxOpen || store.libraryOpen || !!me?.reading || store.achievementsOpen || store.presentOpen || store.chatWith || personMenu || pick)} />}
        <Dock store={store} voice={voice} engine={engine} roomsOpen={showRooms} onRooms={() => setShowRooms(s => !s)} />
      </div>
      </div>
      {store.gameOpen && assets && store.park && <ArcadeOverlay store={store} assets={assets} voice={voice} />}
    </div>
  );
}

const instrumentIcon = (store: Store, user: string) => {
  const o = MAP.objects.find(o => o.use?.kind === 'instrument' && store.instruments[o.id] === user);
  return o?.use?.kind === 'instrument' ? ` ${INSTRUMENTS[o.use.instrument].icon}` : '';
};

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

function TopBar({ store, voice, roomName, onToggleRooms, onToggleMeet, onToggleAppearance, onLogout, editing, onToggleEdit, gmOpen, onToggleGm, pocketsOpen, onTogglePockets }: {
  store: Store; voice: Voice | null; roomName?: string; onToggleRooms: () => void; onToggleMeet: () => void; onToggleAppearance: () => void; onLogout: () => void;
  editing: boolean; onToggleEdit: () => void; gmOpen: boolean; onToggleGm: () => void; pocketsOpen: boolean; onTogglePockets: () => void;
}) {
  const me = store.users.get(store.me);
  const [more, setMore] = useState(false);
  useEffect(() => { // the ⋯ menu closes on a tap anywhere else
    if (!more) return;
    const off = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.topbar')) setMore(false); };
    window.addEventListener('pointerdown', off);
    return () => window.removeEventListener('pointerdown', off);
  }, [more]);
  return (
    <header className="topbar">
      <div className="top-left">
        <span className="brand">The Deck</span>
        {me && <IdentityPill store={store} roomName={roomName} />}
      </div>
      <div className="top-right">
        <VoiceIcons store={store} voice={voice} />
        <UnreadButton store={store} />
        <button className="chip ghost more-btn" aria-label="More" aria-expanded={more} onClick={() => setMore(m => !m)}>⋯</button>
        <div className={`top-more${more ? ' open' : ''}`} onClick={e => { if (!(e.target as HTMLElement).closest('.mac-app')) setMore(false); }}>
          <button onClick={onToggleMeet} className={`chip meet-btn${store.meetLink === '' && !store.google ? ' unset' : ''}`}
            title={store.google ? `Google connected: ${store.google}` : store.meetLink ? `Your Meet room: ${store.meetLink}` : 'Set up Google Meet'}>Meet</button>
          <MacAppButton />
          <button onClick={onToggleRooms} title="Who's where: click a room or a person to walk there" className="chip rooms-btn">People</button>
          <button onClick={onLogout} title="Sign out" className="chip ghost">Leave</button>
        </div>
        <div className="hangers">
          <button onClick={() => store.openAchievements(!store.achievementsOpen)} className="chip hanger-btn trophy-btn"
            title={me?.plant && needsWater(me.plant, store.now()) ? 'Achievements · your plant needs a status today' : 'Achievements and your plant'} aria-label="Achievements and your plant">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8 20h8M9 17h6" /></svg>
            {me?.plant && needsWater(me.plant, store.now()) && <b className="dot" />}
          </button>
          {store.admin && me && !underground(me) && <button onClick={onToggleEdit} className={`chip hanger-btn${editing ? ' on' : ''}`} aria-pressed={editing}
            title={editing ? 'Done rearranging' : 'Rearrange the office (admins)'} aria-label="Rearrange the office">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4" /></svg>
          </button>}
          {store.admin && me && <button onClick={onToggleGm} className={`chip hanger-btn gm-btn${gmOpen ? ' on' : ''}`} aria-pressed={gmOpen}
            title="GM superpowers: buffs and debuffs (admins)" aria-label="GM superpowers">✨</button>}
          <button onClick={onTogglePockets} className={`chip hanger-btn gm-btn${pocketsOpen ? ' on' : ''}`} aria-pressed={pocketsOpen}
            title={`Pockets · ${store.items.length || 'nothing'} ${store.items.length === 1 ? 'thing' : 'things'}`} aria-label="Pockets">🎒</button>
          <button onClick={onToggleAppearance} className="chip hanger-btn" title="Character appearance" aria-label="Character appearance">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a2 2 0 0 0-2 2c0 1 .7 1.6 1.6 2.4.6.5 1.1 1 1.1 1.8V11M12 9l-7 9h14l-7-9ZM3 21h18" /></svg>
          </button>
        </div>
      </div>
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
function AppearanceMenu({ look, assets, firstTime, store, onSave, onClose }: {
  look: PublicLook; assets: Assets | null; firstTime: boolean; store: Store; onSave: (look: PublicLook) => void; onClose: () => void;
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
            <p className="small">Hats are in your pockets 🎒 (take one from the Lobby hat stand){store.judge ? ' · judges find theirs there ✨' : ''}</p>
          </>}
        </div>
        <footer className="appearance-actions">
          <TimeZoneField store={store} />
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
    const r = underground(u) ? 'underground' : u.instance ? 'meetings' : store.roomOf(u)?.id ?? 'hall'; // instances have their own groups
    byRoom.set(r, [...(byRoom.get(r) ?? []), u.id]);
  }
  const offline = [...store.users.values()].filter(u => u.presence === 'offline');
  return (
    <aside className="rooms">
      <div className="rooms-head"><span>People</span><button className="ghost" onClick={onClose}>×</button></div>
      {[...MAP.rooms, { id: 'meetings', name: 'In meetings', rules: { label: 'calendar meetings' }, capacity: 0 } as const,
        { id: 'underground', name: 'Underground', rules: { label: 'somewhere underground' }, capacity: 0 } as const,
        { id: 'hall', name: 'Hallway', rules: { label: 'passing through' }, capacity: 0 } as const].map(r => {
        const ids = byRoom.get(r.id) ?? [];
        const jukebox = MAP.objects.find(o => o.use?.kind === 'jukebox' && store.jukeboxRoom(o.id)?.id === r.id);
        const state = jukebox && store.jukebox[jukebox.id];
        const subtitle = state && r.rules.label ? r.rules.label.replace(/^jukebox/, state.pausedAt !== null ? 'paused' : `♪ ${TRACK.get(state.track)?.title ?? state.track}`) : r.rules.label;
        if ((r.id === 'hall' || r.id === 'meetings' || r.id === 'underground') && !ids.length) return null;
        return (
          <section key={r.id}>
            <h3 onClick={MAP.rooms.some(m => m.id === r.id) ? () => onRoom(r.id) : undefined} title={MAP.rooms.some(m => m.id === r.id) ? `Walk to ${r.name}` : undefined}>{r.name} <small>{ids.length}{r.capacity ? `/${r.capacity}` : ''} · {subtitle}</small></h3>
            <ul>
              {ids.map(id => {
                const u = store.users.get(id)!;
                return (
                  <li key={id} onContextMenu={e => menu(u, e)} title={underground(u) ? 'somewhere underground' : u.status || undefined}>
                    <i style={{ background: PRESENCE_COLOR[u.presence] }} />
                    <button className={`ghost person-name${id === store.me ? ' me' : ''}`} onClick={() => onPick(id)} title={underground(u) ? 'somewhere underground' : id === store.me ? 'Show me' : `Walk to ${u.name}`}>{u.name}{u.game ? u.game.role === 'player' ? ' 🕹' : ' 👀' : ''}{store.roomCallOf(u) ? ` 🎙${userIcons(u)}` : ''}{instrumentIcon(store, u.id)}</button>
                    {more(u)}
                    {!!store.unread.get(id) && <b className="unread" title="Unread messages" onClick={e => { e.stopPropagation(); store.openChat(id); }}>💬 {store.unread.get(id)}</b>}
                    {underground(u) ? <em>somewhere underground</em> : u.door ? <em>{{ arriving: 'just arrived', thinking: 'packing up…', leaving: 'heading out' }[u.door]}</em>
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
    <div className={knockTo ? 'modal-backdrop' : ''} {...(knockTo ? backdropClose(() => done('cancel')) : {})}>
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
  if (!me || underground(me)) return null;
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
const musicPosition = (store: Store, state: JukeboxState) => jukeboxPosition(state, TRACK.get(state.track)?.duration ?? 0, store.now());

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
  return <div className="modal-backdrop" {...backdropClose(close)}>
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
                : mine >= JUKEBOX_PER_PERSON ? `You have ${JUKEBOX_PER_PERSON} tracks queued` : (state?.queue.length ?? 0) >= JUKEBOX_QUEUE_MAX ? 'The queue is full' : undefined;
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

/** What's in your pockets: hats to wear (one at a time) and whatever the bouncer sold you. */
function PocketsPanel({ store, me, assets, onClose }: { store: Store; me: ClientUser; assets: Assets | null; onClose: () => void }) {
  const wearing = String(effectOf(me.effects, 'hat')?.data?.style ?? '');
  const hats = store.items.flatMap(i => (hatOf(i) ? [hatOf(i)!] : []));
  const rest = new Map<string, number>();
  for (const i of store.items) if (!hatOf(i)) rest.set(i, (rest.get(i) ?? 0) + 1);
  const names: Record<string, [string, string]> = { drugs: ['💊', 'Drugs'] };
  return (
    <div className="edit-panel gm-panel">
      <div className="rooms-head"><span>🎒 Pockets</span><button className="ghost" onClick={onClose} aria-label="Close">×</button></div>
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
  useEffect(() => { if (picked) setTarget(picked); }, [picked]);
  const u = store.users.get(target) ?? store.users.get(store.me);
  if (!u) return null;
  const people = [...store.users.values()].filter(p => p.presence !== 'offline').sort((a, b) => a.name.localeCompare(b.name));
  const now = store.now();
  const left = (until?: number) => until === undefined ? '' : ` ${Math.max(0, Math.ceil((until - now) / 1000))}s`;
  return (
    <div className="edit-panel gm-panel">
      <div className="rooms-head"><span>✨ GM superpowers</span><button className="ghost" onClick={onClose} aria-label="Close">×</button></div>
      <label className="look-select">On<select value={u.id} onChange={e => setTarget(e.target.value)}>
        {people.map(p => <option value={p.id} key={p.id}>{p.id === store.me ? `${p.name} (you)` : p.name}</option>)}
      </select></label>
      <p className="hint">Click someone on the floor to aim at them.</p>
      <div className="palette">
        {Object.entries(EFFECTS).filter(([k]) => k !== 'hat').map(([k, r]) => {
          const on = effectOf(u.effects, k);
          return <button key={k} className={on ? 'on' : ''} onClick={() => store.setEffect(u.id, k, !on)} title={on ? `Take ${r.label.toLowerCase()} off` : r.label}>
            <b className="gm-icon">{r.icon}</b><span>{r.label}{on ? left(on.until) : ''}</span>
          </button>;
        })}
      </div>
      <h3>Hat</h3>
      <div className="palette">
        {ALL_HATS.map(h => {
          const on = effectOf(u.effects, 'hat')?.data?.style === h;
          return <button key={h} className={on ? 'on' : ''} onClick={() => store.setEffect(u.id, 'hat', !on, h)}><HatSprite assets={assets} style={h} /><span>{HAT_NAMES[h]}</span></button>;
        })}
      </div>
      {u.effects.length > 0 && <button className="ghost reset" onClick={() => u.effects.forEach(e => store.setEffect(u.id, e.kind, false))}>Clear everything on {u.name.split(' ')[0]}</button>}
      <JudgesSection store={store} assets={assets} />
    </div>
  );
}

/** Admins mark the hackathon judges by sign-in email and give each their own Odyssey hat; it lands in their pockets. */
function JudgesSection({ store, assets }: { store: Store; assets: Assets | null }) {
  const [who, setWho] = useState('');
  const taken = new Set(store.judges.map(j => j.hat)), free = JUDGE_HATS.find(h => !taken.has(h)) ?? JUDGE_HATS[0];
  const add = () => { const w = who.trim(); if (!w) return; store.setJudge(w, free); setWho(''); };
  return (
    <>
      <h3>Judges <small>Each gets their own hat in their pockets.</small></h3>
      {store.judges.map(j => (
        <div className="judge-row" key={j.who}>
          <span className="judge-who" title={j.who}>{j.name ?? j.who}{j.name && <small>{j.who}</small>}</span>
          <span className="judge-hats">{JUDGE_HATS.map(h => (
            <button key={h} className={j.hat === h ? 'on' : ''} onClick={() => store.setJudge(j.who, h)} title={HAT_NAMES[h] + (j.hat !== h && taken.has(h) ? ' (someone has it)' : '')} aria-label={HAT_NAMES[h]} aria-pressed={j.hat === h}>
              <HatSprite assets={assets} style={h} />
            </button>
          ))}</span>
          <button className="ghost" onClick={() => store.setJudge(j.who, null)} title="Not a judge" aria-label={`Remove ${j.who}`}>×</button>
        </div>
      ))}
      <form className="judge-add" onSubmit={e => { e.preventDefault(); add(); }}>
        <input value={who} onChange={e => setWho(e.target.value)} placeholder="name@t1a.com" maxLength={120} aria-label="Judge's sign-in email" />
        <button type="submit" disabled={!who.trim()}>Add</button>
      </form>
    </>
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

/** The Lobby notice board (and the 🏆 button): how your plant is doing, what makes it grow, and your achievements. */
function AchievementsPanel({ store, me, assets }: { store: Store; me: ClientUser; assets: Assets | null }) {
  const now = store.now(), today = dayNumber(now), p = me.plant, close = () => store.openAchievements(false);
  const dead = p && plantDead(p, now), left = p ? PLANT_DIES_DAYS - (today - p.care) : 0;
  const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <div className="modal-backdrop" {...backdropClose(close)}>
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
              <span><b>{a.secret && !got ? '???' : a.title}</b><br /><small>{a.secret && !got ? a.secret : a.how}</small>
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
    <div className="modal-backdrop" {...backdropClose(() => store.closeMeetings())}>
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
        <div className="rooms-head"><span>🕰️ Our time zones</span><button type="button" className="ghost" onClick={() => store.closeClock()}>×</button></div>
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
/** Minutes by which `tz` is ahead of `base` right now. */
function offsetOf(tz: string, base: string, at: Date) {
  const wall = (z: string) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at).map(x => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 60_000; };
  return wall(tz) - wall(base);
}

/** The vault door: where the team's vault lives, and a link that opens it in a new tab. */
function LinkPanel({ store }: { store: Store }) {
  const { label, url } = store.linkOpen!;
  const host = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <div className="modal-backdrop" {...backdropClose(() => store.closeLink())}>
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
    <div className="modal-backdrop" {...backdropClose(() => store.closeCalendar())}>
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
function Dock({ store, voice, engine, roomsOpen, onRooms }: { store: Store; voice: Voice | null; engine: Engine | null; roomsOpen: boolean; onRooms: () => void }) {
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

/** Always opens in a new tab — never replaces the office (some shells ignore target=_blank; the Mac app hands it to the browser). */
function openExternal(href: string) {
  const w = window.open(href, '_blank');
  if (w) { w.opener = null; return; }
  if (inNativeApp()) return; // the Mac app opened it in the system browser and gave us nothing back
  // popup blocked: fall back to a real new-tab anchor click
  const a = document.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
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
    const key = (e: KeyboardEvent) => { if (!store.gameOpen && e.key === 'Escape') { e.stopPropagation(); onClose(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); } };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [at.id]);
  if (!u) return null;
  const reason = store.knockReason(u), away = u.presence === 'offline' || u.door === 'thinking' || u.door === 'leaving';
  const dungeon = store.dungeonReason(u);
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
      <button className="ghost" disabled={away || !!dungeon} title={dungeon ?? undefined} onClick={() => act(() => store.follow(following ? null : u.id))}>{following ? 'Unfollow' : 'Follow'}</button>
      <button className="ghost" disabled={!!reason} title={reason ?? 'Knock for a voice call'} onClick={() => act(() => store.requestKnock(u.id))}>Knock</button>
    </div>
  </div>;
}

/** "Within earshot" for the room tooltip. */
function earshotLine(store: Store) {
  const me = store.users.get(store.me), room = store.roomCallOf(me);
  if (!me || !room) return me?.callId ? `Talking with ${store.names(store.callPeers(me))}` : '';
  const inside = !me.instance && store.roomOf(me)?.id === room.id;
  const near = store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && inside && u.instance === me.instance && store.roomOf(u)?.id === room.id);
  return `In ${room.name} · ${near.length ? `within earshot: ${near.map(u => u.name.split(' ')[0]).join(', ')}` : 'nobody within earshot'}`;
}

/** −, + and ⤢ in the floor's bottom-right corner. */
function ZoomCluster({ engine }: { engine: Engine }) {
  const z = engine.zoom;
  return <div className="zoom" role="group" aria-label="Zoom">
    <button className="chip" onClick={() => engine.zoomOut()} disabled={!z.canOut} title="Zoom out (−, ⌘ scroll or pinch)" aria-label="Zoom out">−</button>
    <button className="chip" onClick={() => engine.zoomIn()} disabled={!z.canIn} title="Zoom in (+, ⌘ scroll or pinch)" aria-label="Zoom in">+</button>
    <button onClick={() => engine.toggleOverview()} className={`chip${z.overview ? ' on' : ''}`} aria-pressed={z.overview}
      title={z.overview ? 'Back to where you were (M)' : 'Whole floor (M)'}>⤢</button>
  </div>;
}

const PRESENCES = [['online', 'Online'], ['away', 'Away'], ['in_call', 'In a call']] as const;

/** You, as one pill: presence dot (opens a presence menu), name, room (earshot tooltip) and status (opens the status popover). */
function IdentityPill({ store, roomName }: { store: Store; roomName?: string }) {
  const me = store.users.get(store.me);
  const [open, setOpen] = useState<'status' | 'presence' | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const close = (save: boolean) => {
    if (save && draftRef.current !== null) store.setStatus(draftRef.current);
    setDraft(null); setOpen(null);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) close(true); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [open]);
  if (!me) return null;
  const text = me.status ?? '';
  const shown = text.length > 24 ? `${text.slice(0, 23)}…` : text;
  const presence = me.presence === 'offline' ? 'online' : me.presence;
  return <div className="id-wrap" ref={ref}>
    <div className="chip id-pill">
      <button className="id-dot" aria-label={`Presence: ${PRESENCES.find(p => p[0] === presence)?.[1]}`} aria-haspopup="menu" aria-expanded={open === 'presence'}
        title="Change presence" onClick={() => (open === 'presence' ? close(true) : (close(true), setOpen('presence')))}>
        <i className="dot" style={{ background: PRESENCE_COLOR[me.presence] }} />
      </button>
      <button className="id-main" aria-haspopup="dialog" aria-expanded={open === 'status'} aria-label={`Status: ${text || 'none'} · click to change`}
        onClick={() => (open === 'status' ? close(true) : setOpen('status'))}>
        <b>{me.name}</b>
        <span className="id-room" title={earshotLine(store)}>· {roomName ? `in ${roomName}` : 'in the hallway'}</span>
        <span className={`id-status${text ? '' : ' muted'}`} title={text ? `${text} · click to change` : 'Set a status (waters your plant)'}>· {shown || 'Set a status'}</span>
      </button>
    </div>
    {open === 'presence' && <div className="presence-pop" role="menu" aria-label="Presence">
      {PRESENCES.map(([id, label]) => <button key={id} role="menuitemradio" aria-checked={presence === id} className={presence === id ? 'on' : 'ghost'}
        onClick={() => { store.setPresence(id); setOpen(null); }}>
        <i className="dot" style={{ background: PRESENCE_COLOR[id] }} />{label}</button>)}
    </div>}
    {open === 'status' && <div className="status-pop" role="dialog" aria-label="Status">
      <form onSubmit={e => { e.preventDefault(); close(true); }}>
        <input autoFocus value={draft ?? text} maxLength={80} placeholder="What are you on? (waters your plant)" onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } }} />
      </form>
      <div className="status-row">
        <button className="ghost" disabled={!text && !draft} onClick={() => { store.setStatus(''); close(false); }}>Clear</button>
      </div>
    </div>}
  </div>;
}

/** A toothed cog (Material "settings" outline), filled; the sun-like line gear read as a brightness control. */
const COG = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';

/** One line-art icon set for the voice buttons, same stroke style as the hanger buttons. `off` draws the same icon crossed out. */
function VIcon({ name, off }: { name: 'mic' | 'speaker' | 'hand' | 'gear' | 'swap'; off?: boolean }) {
  const d = {
    mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
    speaker: 'M4 10v4h3l5 4V6L7 10H4ZM15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10',
    hand: 'M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 5a1.5 1.5 0 0 1 3 0v6M14 6.5a1.5 1.5 0 0 1 3 0V12M8 12l-2-2.5a1.5 1.5 0 0 0-2.4 1.8L7 17.5c1.2 2 3 3.5 6 3.5 3.3 0 5.5-2.2 5.5-5.5V12',
    gear: '',
    swap: 'M4 7h11l-3-3M20 17H9l3 3',
  }[name];
  if (name === 'gear') return <svg viewBox="0 0 24 24" aria-hidden="true"> {/* sound settings: a speaker with a cog in the corner */}
    <path d="M2.5 8.5v5h3l4.5 3.5V5L5.5 8.5h-3ZM13.5 8.5a3 3 0 0 1 0 5" />
    <path className="cog" d={COG} transform="translate(12.5 12.5) scale(0.48)" />
  </svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} />{off && <path className="slash" d="M4 4l16 16" />}</svg>;
}

/** Mic, deafen, hand and sound settings as icon buttons (top bar; the dock on phones). */
function VoiceIcons({ store, voice, dock }: { store: Store; voice: Voice | null; dock?: boolean }) {
  const [pop, setPop] = useState<'settings' | 'claim' | null>(null);
  const settings = pop === 'settings';
  const ref = useRef<HTMLDivElement>(null);
  const me = store.users.get(store.me), room = store.roomCallOf(me), owner = store.connected && store.voiceOwner;
  const elsewhere = store.connected && !store.voiceOwner; // another tab has voice: same four slots, disabled, a badge on the mic
  useEffect(() => {
    if (!pop) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) setPop(null); };
    const key = (e: KeyboardEvent) => { if (!store.gameOpen && e.key === 'Escape') setPop(null); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [pop]);
  useEffect(() => { if (!elsewhere && pop === 'claim') setPop(null); }, [elsewhere]);
  const err = voice?.micError ?? null;
  const muted = voice?.muted ?? prefs.muted, deaf = voice?.deafened ?? prefs.deafened, ptt = (voice?.mode ?? prefs.mode) === 'ptt';
  const btn = (cls: string, icon: React.ReactNode, label: string, title: string, short: string, onClick: () => void, extra: { disabled?: boolean; pressed?: boolean; badge?: boolean } = {}) =>
    <button className={`vbtn chip ${cls}`} disabled={extra.disabled} aria-label={label} aria-pressed={extra.pressed} title={title} onClick={onClick}>
      {icon}{extra.badge && <b className="vbadge" aria-hidden="true" />}{dock && <small>{short}</small>}</button>;
  const waiting = store.voiceWait ? `Waiting for a spot in ${MAP.rooms.find(r => r.id === store.voiceWait)?.name ?? 'room'} voice` : null;
  const away = 'Voice is on in another tab';
  return <div className={`voice-icons${dock ? ' in-dock' : ''}`} ref={ref} role="group" aria-label="Your voice controls">
    {elsewhere
      ? btn('off elsewhere', <VIcon name="mic" off={muted} />, 'Voice is in another tab', `${away} · click to use voice here`, 'Voice',
        () => setPop(p => (p === 'claim' ? null : 'claim')), { pressed: pop === 'claim', badge: true })
      : btn(err ? 'err' : muted ? 'off' : 'live', <VIcon name="mic" off={muted} />, muted ? 'Unmute' : 'Mute',
        err ?? (muted ? 'Muted · click to unmute' : ptt ? 'Mic on · hold Space to talk (click to mute)' : 'Mic live · click to mute') + (ptt && muted ? ' · Space to talk once unmuted' : ''),
        muted ? 'Unmute' : 'Mic', () => voice?.toggleMute(), { disabled: !owner || !voice, pressed: muted })}
    {btn(elsewhere ? 'off' : deaf ? 'off' : 'live', <VIcon name="speaker" off={deaf} />, deaf ? 'Undeafen' : 'Deafen', elsewhere ? away : deaf ? 'Deafened · click to hear again' : 'Hearing everyone · click to deafen',
      deaf ? 'Deaf' : 'Hear', () => voice?.toggleDeafen(), { disabled: !owner || !voice, pressed: deaf })}
    {btn(me?.hand && room ? 'live' : 'off', <VIcon name="hand" />, me?.hand ? 'Lower hand' : 'Raise hand',
      elsewhere ? away : !room ? 'Raise your hand (in a room call)' : me?.hand ? 'Lower your hand' : 'Raise your hand',
      'Hand', () => store.setHand(!me?.hand), { disabled: !owner || !room, pressed: !!me?.hand && !!room })}
    {btn(err ? 'err' : 'off', <VIcon name="gear" />, 'Sound settings', elsewhere ? away : 'Sound settings', 'Sound', () => setPop(p => (p === 'settings' ? null : 'settings')),
      { pressed: settings, disabled: elsewhere })}
    {pop === 'claim' && <div className="settings-pop" role="dialog" aria-label="Voice in another tab">
      <small>{away}.</small>
      <button onClick={() => { setPop(null); store.claimVoice(); }}>Use voice here</button>
    </div>}
    {settings && <div className="settings-pop" role="dialog" aria-label="Sound settings">
      <div className="rooms-head"><span>Sound settings</span><button className="ghost" aria-label="Close sound settings" onClick={() => setPop(null)}>×</button></div>
      {err && <small className="warn">{err}</small>}
      {waiting && <small>{waiting}</small>}
      <EnableSound />
      <label className="input-mode">Input mode<select value={voice?.mode ?? prefs.mode} disabled={!owner || !voice}
        onChange={e => { if (voice && e.target.value !== voice.mode) voice.toggleMode(); }}>
        <option value="voice">Voice activity</option><option value="ptt">Push-to-talk (hold Space)</option>
      </select></label>
      {(['voice', 'music', 'effects'] as Category[]).map(id => <label className="volume-control" key={id}>
        <span>{{ voice: 'Voices', music: 'Music', effects: 'Effects' }[id]}</span>
        <input type="range" min="0" max="100" step="5" value={Math.round(prefs.mix[id] * 100)} aria-label={`${id} volume`}
          onChange={e => { prefs.mix[id] = Number(e.target.value) / 100; savePrefs(); }} /><output>{Math.round(prefs.mix[id] * 100)}%</output>
      </label>)}
    </div>}
  </div>;
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
          {t.actions?.map(a => <button key={a.label} className={a.ghost ? 'ghost' : ''} onClick={() => { store.dismiss(t.id); a.run(); }}>{a.label}</button>)}
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

type WheelItem = { icon: string; label: string; onClick: () => void; disabled?: boolean; title?: string; active?: boolean; hat?: string }; // hat: draw that hat's sprite instead of the icon

/** Click a person or a thing: a ring of actions around it, following it as it moves. */
function ActionWheel({ store, engine, pick, assets, onPerson, onClose }: { store: Store; engine: Engine; pick: Pick; assets: Assets | null; onPerson: (at: PersonMenuAt) => void; onClose: () => void }) {
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
    if (!u || u.presence === 'offline') return null;
    title = isMe ? 'You' : u.name.split(' ')[0];
    if (emoji) {
      items = REACTIONS.map(e => ({ icon: e, label: '', onClick: act(() => store.react(u.id, e)) }));
      const held = isMe && me?.holding ? ITEMS.get(me.holding) : undefined;
      if (isMe && me?.eating) items.push({ icon: me.eating.open ? '🔕' : '💬', label: me.eating.open ? 'Closed' : 'Open', title: me.eating.open ? 'Not up for company: knocks go to Later' : 'Open to talk: anyone at your table can knock', onClick: act(() => store.lunchOpen(!me.eating!.open)) });
      if (!isMe) items.push({ icon: '↩', label: 'Back', onClick: () => setEmoji(false) });
      else if (held) items.push({ icon: held.icon, label: 'Finish', title: `Finish your ${held.label.toLowerCase()}`, onClick: act(() => store.drop()) });
      if (isMe && me?.following) items.push({ icon: '🛑', label: 'Stop following', onClick: act(() => store.follow(null)) });
    } else {
      const away = u.door === 'thinking' || u.door === 'leaving';
      const dungeon = store.dungeonReason(u);
      const following = me?.following === u.id, noKnock = store.knockReason(u);
      items = [
        { icon: '✊', label: 'Knock', onClick: act(() => store.requestKnock(u.id)), disabled: !!noKnock,
          title: noKnock ?? 'Knock for a voice call' },
        { icon: '👣', label: following ? 'Unfollow' : 'Follow', active: following, onClick: act(() => store.follow(following ? null : u.id)), disabled: away || !!dungeon, title: dungeon ?? undefined },
        { icon: '😊', label: 'React', onClick: () => setEmoji(true) },
        { icon: '💬', label: 'Message', onClick: act(() => store.openChat(u.id)) },
      ];
      if (isMe && (store.dancing || (store.roomOf(u)?.id === DANCE_ROOM && !u.instance))) items.push({ icon: '💃', label: store.dancing ? 'Stop dancing' : 'Dance', onClick: act(() => store.dance()) });
      if (me?.callId && me.callId === u.callId) items.push({ icon: '🔊', label: 'Volume', onClick: act(() => { if (at) onPerson({ id: u.id, x, y }); }) });
      const held = me?.holding ? ITEMS.get(me.holding) : undefined;
      if (held) items.push({ icon: held.icon, label: 'Give', disabled: !!u.holding || away || !!dungeon,
        title: dungeon ?? (u.holding ? `${u.name.split(' ')[0]}'s hands are full` : `Give ${u.name.split(' ')[0]} your ${held.label.toLowerCase()}`),
        onClick: act(() => store.give(u.id)) });
    }
  } else {
    const o = MAP.objects.find(o => o.id === pick.id);
    const meal = o?.type === 'chair' && me?.holding ? ITEMS.get(me.holding) : undefined;
    if (o && meal && picnicSeat(MAP, o)) { // a chair at a picnic table, food in hand
      title = `${meal.icon} Eat lunch here`;
      items = [{ icon: '🍽', label: 'Eat', title: `Eat your ${meal.label.toLowerCase()} here (${LUNCH_MS / 60_000} min)`, onClick: act(() => store.lunch({ x: o.x, y: o.y }, false)) },
        { icon: '💬', label: 'Open', title: 'Eat here, and welcome anyone at the table to knock', onClick: act(() => store.lunch({ x: o.x, y: o.y }, true)) }];
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
          { icon: '🚪', label: 'Leave', onClick: act(() => store.moveTo({ x: o.x, y: o.y - 2 })) }];
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
      items = [{ icon: on ? '🌑' : '💡', label: on ? 'Turn off' : 'Turn on', onClick: act(() => store.use(o.id)) }];
    } else if (o.use.kind === 'take') {
      title = o.type === 'coffee_machine' ? 'Coffee machine' : o.type === 'fridge' ? 'Fridge' : o.type === 'food_cart' ? 'Food cart' : o.type;
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
