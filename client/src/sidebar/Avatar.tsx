import { useEffect, useRef, useState } from 'react';
import type { Assets } from '../assets';
import type { ClientUser, Store } from '../net';
import type { Engine } from '../engine';
import { PRESENCE_COLOR } from './model';
const heads = new Map<string, HTMLCanvasElement>();
export function Avatar({ assets, user, size, ring, dot = true }: { assets: Assets | null; user: ClientUser; size: number; ring?: boolean; dot?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!assets || !ref.current) return;
    const key = JSON.stringify(user.look);
    let head = heads.get(key);
    if (!head) {
      head = document.createElement('canvas'); head.width = head.height = 16;
      head.getContext('2d')!.drawImage(assets.sheet(user.look), 0, 0, 16, 16, 0, 0, 16, 16); heads.set(key, head);
    }
    const ctx = ref.current.getContext('2d')!, n = 16 * Math.max(1, Math.floor((size === 80 ? 64 : size) / 16));
    ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, size, size); ctx.drawImage(head, (size - n) / 2, (size - n) / 2, n, n);
  }, [assets, user.look, size]);
  return <span className={`sb-avatar${ring ? ' speaking' : ''}${size >= 40 ? ' large' : ''}`} style={{ width: size, height: size }}>
    {assets ? <canvas ref={ref} width={size} height={size} aria-hidden="true" /> : user.name[0]}
    {dot && <i style={{ background: PRESENCE_COLOR[user.afk && user.presence !== 'offline' ? 'away' : user.presence] }} />}
  </span>;
}
export function useSpeaking(store: Store, engine: Engine | null) {
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const poll = () => {
      const next = new Set([...store.users.values()].filter(u => engine ? engine.isSpeaking(u) : !!u.speaking && !u.muted && !u.deafened).map(u => u.id));
      setSpeaking(prev => prev.size === next.size && [...next].every(id => prev.has(id)) ? prev : next);
    };
    poll(); const timer = setInterval(poll, 150); return () => clearInterval(timer);
  }, [store, engine]);
  return speaking;
}
