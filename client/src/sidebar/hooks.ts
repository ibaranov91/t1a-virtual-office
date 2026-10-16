import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Store } from '../net';
export const COMPACT = '(max-width: 560px), (max-height: 500px)';
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query), change = () => setMatches(media.matches);
    change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [query]);
  return matches;
}
export const popoverOpen = () => !!document.querySelector('.presence-pop, .status-pop, .voice-icons .settings-pop');
export function useSurface(store: Store, at: { x: number; y: number }, compact: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null), onClose = useRef(close); onClose.current = close;
  useLayoutEffect(() => {
    const el = ref.current; if (!el || compact) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))}px`;
  });
  useEffect(() => {
    const previous = document.activeElement;
    (ref.current?.querySelector<HTMLElement>('[data-action]:not(:disabled)') ?? ref.current)?.focus();
    const outside = (e: PointerEvent) => {
      if (!store.gameOpen && e.target instanceof Node && !ref.current?.contains(e.target)) onClose.current();
    };
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('pointerdown', outside);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else if (!compact) document.querySelector<HTMLInputElement>('.sb-search')?.focus();
    };
  }, [store, compact]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!store.gameOpen && e.key === 'Escape' && !popoverOpen()) { e.stopPropagation(); onClose.current(); }
  };
  return { ref, onKeyDown, tabIndex: -1 };
}
