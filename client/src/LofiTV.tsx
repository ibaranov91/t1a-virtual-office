import { useEffect, useRef, useState } from 'react';
import { MAP, type Store } from './net';
import { prefs, savePrefs } from './prefs';

type Player = { destroy(): void; pauseVideo(): void; playVideo(): void; setVolume(value: number): void };
type YouTube = { Player: new (host: HTMLElement, options: {
  videoId: string; playerVars: Record<string, string | number>;
  events: { onReady(): void; onStateChange(event: { data: number }): void; onError(): void; onAutoplayBlocked(): void };
}) => Player };
const ytWindow = window as unknown as { YT?: YouTube; onYouTubeIframeAPIReady?: () => void };
let api: Promise<YouTube> | undefined;
function youtube() {
  if (ytWindow.YT?.Player) return Promise.resolve(ytWindow.YT);
  return api ??= new Promise<YouTube>((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    const timeout = window.setTimeout(() => reject(new Error('YouTube did not load')), 15000);
    const previous = ytWindow.onYouTubeIframeAPIReady;
    ytWindow.onYouTubeIframeAPIReady = () => { previous?.(); clearTimeout(timeout); resolve(ytWindow.YT!); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('YouTube is unavailable')); };
    document.head.append(script);
  }).catch(error => { api = undefined; throw error; });
}

export function LofiTV({ store, id, onClose }: { store: Store; id: string; onClose(): void }) {
  const use = MAP.objects.find(o => o.id === id)?.use;
  const roomId = use?.kind === 'youtube' ? use.room : '', videoId = use?.kind === 'youtube' ? use.videoId : '';
  const me = store.users.get(store.me), inside = store.connected && !!me && !me.instance && store.roomOf(me)?.id === roomId;
  const host = useRef<HTMLDivElement>(null), player = useRef<Player | null>(null), entered = useRef(false);
  const [playing, setPlaying] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const volume = prefs.jukeboxVolumes[id] ?? .35;
  const level = () => prefs.deafened ? 0 : Math.round((prefs.jukeboxVolumes[id] ?? .35) * prefs.mix.music * 100);
  useEffect(() => {
    if (inside) entered.current = true;
    else if (entered.current) onClose();
  }, [inside, onClose]);
  useEffect(() => {
    if (!inside || !videoId || !host.current) return;
    let disposed = false;
    setError(false); setReady(false); setBlocked(false);
    youtube().then(YT => {
      if (disposed || !host.current) return;
      const target = document.createElement('div'); host.current.append(target);
      const p = new YT.Player(target, {
        videoId, playerVars: { autoplay: document.hidden ? 0 : 1, playsinline: 1, origin: location.origin },
        events: {
          onReady: () => { if (disposed) return; p.setVolume(level()); if (document.hidden) p.pauseVideo(); setReady(true); },
          onStateChange: e => { if (!disposed) { if (e.data === 1 && document.hidden) { p.pauseVideo(); setPlaying(false); return; } if (e.data === 1) { setPlaying(true); setBlocked(false); setError(false); } else if ([0, 2, -1, 5].includes(e.data)) setPlaying(false); } },
          onError: () => { if (!disposed) { setError(true); setPlaying(false); } },
          onAutoplayBlocked: () => { if (!disposed) setBlocked(true); },
        },
      });
      player.current = p;
      if (import.meta.env.DEV) Object.assign(window, { __lofiPlayer: p });
    }).catch(() => { if (!disposed) setError(true); });
    const visibility = () => { if (document.hidden) player.current?.pauseVideo(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true; document.removeEventListener('visibilitychange', visibility);
      player.current?.destroy(); player.current = null; setPlaying(false);
      if (import.meta.env.DEV) Reflect.deleteProperty(window, '__lofiPlayer');
    };
  }, [inside, videoId]);
  useEffect(() => { if (ready) player.current?.setVolume(level()); }, [ready, volume, prefs.mix.music, prefs.deafened]);
  useEffect(() => {
    const sound = store.soundscape;
    if (sound) sound.tvRoom = playing && inside ? roomId : null;
    return () => { if (sound) sound.tvRoom = null; };
  }, [store, playing, inside, roomId]);
  if (!videoId) return null;
  const room = MAP.rooms.find(r => r.id === roomId);
  return <aside className="lofi-tv" aria-label="Lofi Girl TV">
    <div className="lofi-tv-head"><h2><svg viewBox="0 0 28 20" aria-hidden="true"><rect width="28" height="20" rx="5" fill="#f03b40" /><path d="M11 5 20 10 11 15Z" fill="white" /></svg>Lofi Girl <span className="lofi-live">LIVE</span></h2>
      <button className="ghost" aria-label="Close TV" onClick={onClose}>×</button></div>
    {inside ? <div className="lofi-player" ref={host} /> : <div className="lofi-tv-walk"><p>Walk into {room?.name ?? 'Music'} to watch and listen.</p>
      <button onClick={() => { const spot = room?.stand[0]; if (spot) store.moveTo(spot); }}>Walk to Music</button></div>}
    {inside && <label className="volume-control jukebox-volume"><span>Volume for me</span>
      <input type="range" min="0" max="100" step="5" value={Math.round(volume * 100)} aria-label="TV volume for me"
        onChange={e => { prefs.jukeboxVolumes[id] = Number(e.target.value) / 100; savePrefs(); }} /><output>{Math.round(volume * 100)}%</output></label>}
    <p className="small" role="status">{error ? 'The stream is unavailable here. Try opening it on YouTube.' : blocked ? 'Press Play in the video to start listening.' : playing ? 'Jukebox muted for you while TV plays.' : inside && !ready ? 'Connecting to YouTube…' : 'Live lofi beats · relax / study'}</p>
    <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a>
  </aside>;
}
