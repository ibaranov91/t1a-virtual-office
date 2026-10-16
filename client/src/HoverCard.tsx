import { memo, useEffect, useRef, useState } from 'react';
import type { Assets } from './assets';
import type { Engine } from './engine';
import { ITEMS, type ClientUser, type Store } from './net';
import { Icon } from './Icon';
import { Avatar } from './sidebar/Avatar';
import { useMedia } from './sidebar/hooks';
import { bannerStyle, hoverCard } from './sidebar/model';

type Snapshot = { id: string; user: ClientUser; speaking: boolean; content: ReturnType<typeof hoverCard> };
export const HoverCard = memo(function HoverCard({ store, engine, assets, compact }: {
  store: Store; engine: Engine; assets: Assets | null; compact: boolean;
}) {
  const touch = useMedia('(hover: none)'), ref = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    if (compact || touch) { setSnapshot(null); return; }
    let raf = 0, signature = '', previousInput = '';
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tick = () => {
      const el = ref.current, stage = el?.parentElement;
      const id = engine.hoverUser, u = id && store.users.get(id);
      const wheelOpen = engine.selected?.kind === 'user' && engine.selected.id === id;
      if (!u || wheelOpen || engine.tapZooms || engine.editing) {
        if (el) el.style.visibility = 'hidden';
        if (signature) { signature = ''; previousInput = ''; setSnapshot(null); }
      } else {
        const now = store.now(), speaking = engine.isSpeaking(u);
        const input = `${u.id}:${store.version}:${Math.floor(now / 1000)}:${speaking}`;
        if (input !== previousInput) {
          previousInput = input;
          const content = hoverCard(store, u, {
            now, zone, speaking, items: ITEMS,
            tableDescription: (objectId, userId) => store.tableDescription(objectId, userId),
            gameDescription: (cabinet, userId) => store.gameDescription(cabinet, userId),
            articleTitle: articleId => store.library.articles.find(a => a.id === articleId)?.title,
          });
          const next = JSON.stringify([u.id, content, u.look, u.presence, speaking]);
          if (next !== signature) {
            signature = next;
            setSnapshot({ id: u.id, user: { ...u, look: { ...u.look } }, speaking, content });
          }
        }
        const anchor = engine.anchor({ kind: 'user', id: u.id });
        if (el && stage && anchor && el.dataset.id === u.id) {
          const bounds = stage.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
          const x = anchor.x - bounds.left, y = anchor.y - bounds.top;
          const above = y - anchor.r - 10 - h, below = y + anchor.r + 10;
          const top = above >= 8 ? above : below;
          // If neither side fits, keep the sprite unobscured instead of clamping over it.
          const fits = x + anchor.r >= 0 && x - anchor.r <= bounds.width && top >= 8 && top + h <= bounds.height - 8;
          el.style.visibility = fits ? 'visible' : 'hidden';
          el.style.transform = `translate(${Math.max(8, Math.min(bounds.width - w - 8, x - w / 2))}px, ${top}px)`;
          el.style.setProperty('--hover-origin', above >= 8 ? 'bottom' : 'top');
        } else if (el) el.style.visibility = 'hidden';
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [store, engine, compact, touch]);
  const c = snapshot?.content;
  return <div ref={ref} className="hover-card-anchor" data-id={snapshot?.id} aria-hidden="true">
    {snapshot && c && <div className="hover-card" key={snapshot.id}>
      <div className="hover-card-banner" style={{ background: bannerStyle(snapshot.user.banner, snapshot.user.look) }} />{/* the same banner as their card: one family */}
      <div className="hover-card-header">
        <Avatar assets={assets} user={snapshot.user} size={32} ring={snapshot.speaking} />
        <div className="hover-card-name"><strong>{c.name}</strong>{c.emoji && <span>{c.emoji}</span>}{c.you && <small>{c.you}</small>}</div>
      </div>
      <div className={`hover-card-presence${c.live ? ' live' : ''}`}>{c.presence}</div>
      {c.status && <div className="hover-card-status">{c.status}</div>}
      {!!c.pills.length && <div className="hover-card-pills">{c.pills.map((pill, i) => <span key={i}>{pill}</span>)}</div>}
      {c.localTime && <div className="hover-card-time"><Icon name="clock" />{c.localTime}</div>}
      {c.footer && <div className="hover-card-footer">{c.footer}</div>}
    </div>}
  </div>;
});
