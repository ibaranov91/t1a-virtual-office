import { useEffect, useRef } from 'react';
import type { Assets } from './assets';
import { effectLook } from './effects';
import { LogoShow } from './logo';
import type { Store } from './net';
import { useMedia } from './sidebar/hooks';

/** "The Deck" in the top bar, now and then built by whoever is in the office (logo.ts). Static with reduced motion. */
export function BrandLogo({ store, assets }: { store: Store; assets: Assets | null }) {
  const text = useRef<HTMLSpanElement>(null), canvas = useRef<HTMLCanvasElement>(null), show = useRef<LogoShow | null>(null);
  const still = useMedia('(prefers-reduced-motion: reduce)');
  useEffect(() => {
    if (still || !text.current || !canvas.current) return;
    const s = show.current = new LogoShow(text.current, canvas.current,
      () => [...store.users.values()].filter(u => u.presence !== 'offline').map(u => effectLook(u.look, u.effects)));
    return () => { s.destroy(); show.current = null; };
  }, [still, store]);
  useEffect(() => { show.current?.setAssets(assets); }, [assets, still]);
  return <span ref={text} className="brand">The Deck{!still && <canvas ref={canvas} className="brand-canvas" aria-hidden="true" />}</span>;
}
