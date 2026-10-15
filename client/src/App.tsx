import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadAssets, type Assets } from './assets';
import { Engine, type Pick } from './engine';
import { Voice } from './voice';
import { playKnock, setSoundsOn, soundsOn } from './sounds';
import { ITEMS, MAP, Store } from './net';
import { inNativeApp, syncNative } from './native';
import { MAX_CHAT_LEN, MEET_LINK_RE, meetAs, normalizeMeetLink, REACTIONS } from '../../shared/protocol';
import { seatAt } from '../../shared/map';

// Dev server: sign in automatically as ?as=<name> (default "Dev"); each name keeps its own session,
// so several tabs can be different people.
const DEV_AS = import.meta.env.DEV ? (new URLSearchParams(location.search).get('as')?.trim() || 'Dev') : null;
const SESSION_KEY = DEV_AS ? `deck.session.dev.${DEV_AS.toLowerCase()}` : 'deck.session';

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
  const [, tick] = useState(0);

  useEffect(() => { store.connect(); return () => store.close(); }, [store]);
  // built-in voice for knock calls
  const [voice, setVoice] = useState<Voice | null>(null);
  useEffect(() => syncNative(store), [store]);
  useEffect(() => {
    let v: Voice | null = null, unsub = () => {};
    fetch('/api/config').then(r => r.json()).then(c => {
      v = new Voice(store, c.iceServers ?? []);
      unsub = store.subscribe(() => v!.sync());
      v.sync(); setVoice(v);
      if (import.meta.env.DEV) Object.assign(window, { __voice: v });
    }).catch(() => {});
    return () => { unsub(); v?.destroy(); };
  }, [store]);
  useEffect(() => { loadAssets().then(setAssets); }, []);
  useEffect(() => {
    if (!assets || !canvasRef.current) return;
    const e = new Engine(canvasRef.current, store, assets);
    e.onPick = p => setPick(cur => (p && cur?.kind === p.kind && cur.id === p.id ? null : p)); // same target again: close
    engineRef.current = e;
    if (import.meta.env.DEV) Object.assign(window, { __deck: { store, engine: e } });
    return () => e.destroy();
  }, [assets, store]);
  useEffect(() => { const i = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(i); }, []);
  useEffect(() => { if (engineRef.current) engineRef.current.selected = pick; }, [pick]);

  const me = store.users.get(store.me);
  const myRoom = me ? store.roomOf(me) : undefined;

  return (
    <div className="office">
      <TopBar store={store} roomName={myRoom?.name} onToggleRooms={() => setShowRooms(s => !s)} onLogout={onLogout}
        onToggleMeet={() => setShowMeet(s => !s)}
        onZoom={(d) => engineRef.current?.setZoom((engineRef.current.zoomBias ?? 0) + d)} />
      <div className="stage">
        <div className="canvas-wrap"><canvas ref={canvasRef} /></div>
        {!assets && <div className="loading">Unlocking the door…</div>}
        {!store.connected && assets && <div className="loading small">Reconnecting…</div>}
        {showRooms && <RoomList store={store} onPick={(id) => engineRef.current?.focusUser(id)} onClose={() => setShowRooms(false)} />}
        {(showMeet || store.pendingKnock) && <MeetSetup key={store.pendingKnock ?? 'panel'} store={store} onClose={() => setShowMeet(false)} />}
        <div className="chips">
          <CallChip store={store} voice={voice} />
          <DeskChip store={store} />
        </div>
        <Toasts store={store} />
        {pick && engineRef.current && <ActionWheel key={`${pick.kind}:${pick.id}`} store={store} engine={engineRef.current} pick={pick} onClose={() => setPick(null)} />}
        {store.chatWith && <ChatPanel key={store.chatWith} store={store} withId={store.chatWith} />}
      </div>
    </div>
  );
}

function TopBar({ store, roomName, onToggleRooms, onToggleMeet, onLogout, onZoom }: {
  store: Store; roomName?: string; onToggleRooms: () => void; onToggleMeet: () => void; onLogout: () => void; onZoom: (d: number) => void;
}) {
  const me = store.users.get(store.me);
  const [draft, setDraft] = useState<string | null>(null);
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
        <button onClick={() => onZoom(-1)} title="Zoom out">−</button>
        <button onClick={() => onZoom(1)} title="Zoom in">+</button>
      </div>
      <button onClick={onToggleMeet} className={`meet-btn${store.meetLink === '' ? ' unset' : ''}`}
        title={store.meetLink ? `Your Meet room: ${store.meetLink}` : 'Set your Google Meet link'}>Meet</button>
      <SoundToggle />
      <MacAppButton />
      <button onClick={onToggleRooms} title="Rooms">Rooms</button>
      <button onClick={onLogout} title="Sign out" className="ghost">Leave</button>
    </header>
  );
}

const PRESENCE_COLOR: Record<string, string> = { online: '#7cc87c', away: '#e0b050', in_call: '#d86a5a', offline: '#666' };

function RoomList({ store, onPick, onClose }: { store: Store; onPick: (id: string) => void; onClose: () => void }) {
  const byRoom = new Map<string, string[]>();
  for (const u of store.users.values()) {
    if (u.presence === 'offline') continue;
    const r = store.roomOf(u)?.id ?? 'hall';
    byRoom.set(r, [...(byRoom.get(r) ?? []), u.id]);
  }
  const offline = [...store.users.values()].filter(u => u.presence === 'offline');
  return (
    <aside className="rooms">
      <div className="rooms-head"><span>Rooms</span><button className="ghost" onClick={onClose}>×</button></div>
      {[...MAP.rooms, { id: 'hall', name: 'Hallway', rules: { label: 'passing through' }, capacity: 0 } as const].map(r => {
        const ids = byRoom.get(r.id) ?? [];
        if (r.id === 'hall' && !ids.length) return null;
        return (
          <section key={r.id}>
            <h3>{r.name} <small>{ids.length}{r.capacity ? `/${r.capacity}` : ''} · {r.rules.label}</small></h3>
            <ul>
              {ids.map(id => {
                const u = store.users.get(id)!;
                return (
                  <li key={id} onClick={() => onPick(id)} title={u.status || undefined}>
                    <i style={{ background: PRESENCE_COLOR[u.presence] }} />
                    <span className={id === store.me ? 'me' : ''}>{u.name}</span>
                    {!!store.unread.get(id) && <b className="unread" title="Unread messages" onClick={e => { e.stopPropagation(); store.openChat(id); }}>💬 {store.unread.get(id)}</b>}
                    {u.door ? <em>{{ arriving: 'just arrived', thinking: 'packing up…', leaving: 'heading out' }[u.door]}</em> : u.status && <em>{u.status}</em>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {offline.length > 0 && <section><h3>Offline <small>{offline.length}</small></h3><ul>{offline.map(u => <li key={u.id} className="off"><i style={{ background: PRESENCE_COLOR.offline }} />{u.name}</li>)}</ul></section>}
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
  return (
    <div className={knockTo ? 'modal-backdrop' : ''} onClick={e => { if (knockTo && e.target === e.currentTarget) done('cancel'); }}>
      <form className={`meet-panel${knockTo ? ' guided' : ''}`} onSubmit={e => { e.preventDefault(); if (parsed) save(parsed); }}>
        <div className="rooms-head">
          <span>{knockTo ? `Before you knock on ${knockTo.name.split(' ')[0]}…` : 'Your Google Meet room'}</span>
          <button type="button" className="ghost" onClick={() => done('cancel')}>×</button>
        </div>
        <p className="muted">
          {knockTo ? 'Set up your own Meet room once. When someone accepts your knock, you both join it — no more two separate calls.'
            : 'When you knock and they accept, you both join this room.'}
        </p>
        <ol className="steps">
          <li>Open <ExternalLink href={meetAs('https://meet.google.com/', store.email)}>meet.google.com</ExternalLink> (opens a new tab)
            {store.email && <> as <b>{store.email}</b></>}</li>
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
      </form>
    </div>
  );
}

/** Knock sound on/off, remembered per browser. Turning it on plays a sample. */
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

function SoundToggle() {
  const [on, setOn] = useState(soundsOn);
  return (
    <button className="ghost sound-btn" title={on ? 'Knock sound on (click to mute)' : 'Knock sound off'}
      onClick={() => { setSoundsOn(!on); setOn(!on); if (!on) playKnock(); }}>
      {on ? '🔔' : '🔕'}
    </button>
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

/** While you're on a knock call: who with, rejoin, hang up. */
function CallChip({ store, voice }: { store: Store; voice: Voice | null }) {
  const me = store.users.get(store.me);
  if (!me?.callId) return null;
  const peers = store.callPeers(me);
  const humans = peers.filter(u => !u.bot).length;
  const state = !voice ? 'starting…'
    : voice.micError ? 'listen-only'
    : humans === 0 ? 'no one to hear you'
    : voice.connectedCount() < humans ? 'connecting…' : voice.muted ? 'muted' : 'live';
  // only offer Meet when the call has a real shared room (not meet.google.com/new)
  const meet = store.callLink && MEET_LINK_RE.test(store.callLink) ? store.callLink : null;
  return (
    <div className="desk-chip call-chip">
      <span className={`dot ${state === 'live' ? 'live' : ''}`} />
      <span>Talking with {store.names(peers)} <small className="muted">· {state}</small></span>
      {voice?.needsGesture && <button onClick={() => voice.resumeAudio()}>Enable sound</button>}
      {voice && !voice.micError && (
        <button className={voice.muted ? 'muted-btn' : 'ghost'} onClick={() => voice.toggleMute()} title={voice.muted ? 'Unmute' : 'Mute'}>
          {voice.muted ? '🔇 Unmute' : '🎙 Mute'}
        </button>
      )}
      {meet && <ExternalLink href={meetAs(meet, store.email)}>Move to Meet</ExternalLink>}
      <button className="end" onClick={() => store.endCall()}>Leave</button>
    </div>
  );
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
          {t.kind === 'link' && t.link && <ExternalLink href={meetAs(t.link, store.email)} onOpen={() => store.dismiss(t.id)}>Join call</ExternalLink>}
          {t.kind !== 'knock_in' && t.kind !== 'knock_out' && <button className="ghost x" onClick={() => store.dismiss(t.id)}>×</button>}
        </div>
      ))}
    </div>
  );
}

type WheelItem = { icon: string; label: string; onClick: () => void; disabled?: boolean; title?: string; active?: boolean };

/** Click a person or a thing: a ring of actions around it, following it as it moves. */
function ActionWheel({ store, engine, pick, onClose }: { store: Store; engine: Engine; pick: Pick; onClose: () => void }) {
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
      const room = store.roomOf(u);
      const talking = !!me?.callId && me.callId === u.callId;
      const away = u.door === 'thinking' || u.door === 'leaving';
      const following = me?.following === u.id;
      items = [
        { icon: '✊', label: 'Knock', onClick: act(() => store.requestKnock(u.id)), disabled: talking || away || room?.rules.knock === 'disabled',
          title: talking ? 'Already talking' : away ? 'Heading out' : room?.rules.knock === 'disabled' ? `${room.name}: ${room.rules.label}` : 'Knock for a voice call' },
        { icon: '👣', label: following ? 'Unfollow' : 'Follow', active: following, onClick: act(() => store.follow(following ? null : u.id)), disabled: away },
        { icon: '😊', label: 'React', onClick: () => setEmoji(true) },
        { icon: '💬', label: 'Message', onClick: act(() => store.openChat(u.id)) },
      ];
      const held = me?.holding ? ITEMS.get(me.holding) : undefined;
      if (held) items.push({ icon: held.icon, label: 'Give', disabled: !!u.holding || away,
        title: u.holding ? `${u.name.split(' ')[0]}'s hands are full` : `Give ${u.name.split(' ')[0]} your ${held.label.toLowerCase()}`,
        onClick: act(() => store.give(u.id)) });
    }
  } else {
    const o = MAP.objects.find(o => o.id === pick.id);
    if (!o?.use) return null;
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
  const y = Math.round(Math.min(Math.max(at.y, R + 70), window.innerHeight - R - 30));
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
