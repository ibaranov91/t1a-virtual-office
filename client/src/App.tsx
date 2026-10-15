import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadAssets, type Assets } from './assets';
import { Engine } from './engine';
import { MAP, Store } from './net';

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

type Config = { netbird: boolean; tokenLogin: boolean };

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
            <label>Team token<input value={token} onChange={e => setToken(e.target.value)} type="password" /></label>
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
  const [, tick] = useState(0);

  useEffect(() => { store.connect(); return () => store.close(); }, [store]);
  useEffect(() => { loadAssets().then(setAssets); }, []);
  useEffect(() => {
    if (!assets || !canvasRef.current) return;
    const e = new Engine(canvasRef.current, store, assets);
    engineRef.current = e;
    if (import.meta.env.DEV) Object.assign(window, { __deck: { store, engine: e } });
    return () => e.destroy();
  }, [assets, store]);
  useEffect(() => { const i = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(i); }, []);

  const me = store.users.get(store.me);
  const myRoom = me ? store.roomOf(me) : undefined;

  return (
    <div className="office">
      <TopBar store={store} roomName={myRoom?.name} onToggleRooms={() => setShowRooms(s => !s)} onLogout={onLogout}
        onZoom={(d) => engineRef.current?.setZoom((engineRef.current.zoomBias ?? 0) + d)} />
      <div className="stage">
        <div className="canvas-wrap"><canvas ref={canvasRef} /></div>
        {!assets && <div className="loading">Unlocking the door…</div>}
        {!store.connected && assets && <div className="loading small">Reconnecting…</div>}
        {showRooms && <RoomList store={store} onPick={(id) => engineRef.current?.focusUser(id)} onClose={() => setShowRooms(false)} />}
        <Toasts store={store} />
      </div>
    </div>
  );
}

function TopBar({ store, roomName, onToggleRooms, onLogout, onZoom }: {
  store: Store; roomName?: string; onToggleRooms: () => void; onLogout: () => void; onZoom: (d: number) => void;
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

function Toasts({ store }: { store: Store }) {
  return (
    <div className="toasts">
      {store.toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'knock_in' && <span className="bang">!</span>}
          <span className="txt">{t.text}</span>
          {t.kind === 'knock_in' && t.knockId && <>
            <button onClick={() => store.replyKnock(t.knockId!, 'accept')}>Accept</button>
            <button className="ghost" onClick={() => store.replyKnock(t.knockId!, 'later')}>Later</button>
          </>}
          {t.kind === 'link' && t.link && <a href={t.link} target="_blank" rel="noreferrer" onClick={() => store.dismiss(t.id)}>Join call</a>}
          {t.kind !== 'knock_in' && <button className="ghost x" onClick={() => store.dismiss(t.id)}>×</button>}
        </div>
      ))}
    </div>
  );
}
