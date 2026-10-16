import { useEffect, useId, useRef, type HTMLAttributes } from 'react';
import { dayNumber, kindName, PLANT_DIES_DAYS, PLANT_KINDS, PLANT_REVEAL, PLANT_STAGES, plantDead, plantName, type Achievement, type Plant } from '../../shared/protocol';
import type { Assets } from './assets';
import type { Store, ClientUser } from './net';
import { progressOf, rarityOf, sections, summary } from './achievements';
import { Icon, IconButton } from './Icon';

function PlantSprite({ assets, plant, now, scale = 5 }: { assets: Assets | null; plant: Plant; now: number; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const name = plantDead(plant, now) ? 'pot_dead' : plant.kind && plant.stage >= PLANT_REVEAL ? `pot_${plant.kind}_${plant.stage}` : `pot_${plant.stage}`;
  useEffect(() => {
    const c = ref.current, f = assets?.atlas.frames[name]; if (!c || !f || !assets) return;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(assets.world, f.x, f.y, f.w, f.h, 0, 0, f.w * scale, f.h * scale);
  }, [assets, name, scale]);
  return <canvas ref={ref} width={12 * scale} height={20 * scale} className="plant-sprite" aria-hidden="true" />;
}

export function AchievementBadge({ a, unlocked = false }: { a: Achievement; unlocked?: boolean }) {
  return <span className={`achievement-badge${unlocked ? ' got' : ' locked'}${a.soon ? ' soon' : ''}`} aria-hidden="true">
    <span>{a.secret && !unlocked ? '?' : a.icon}</span>
  </span>;
}
export function AchievementRarity({ id, store, unlocked = false }: { id: string; store: Store; unlocked?: boolean }) {
  const rarity = rarityOf(id, store.users);
  if (rarity && !rarity.has) return <span className="achievement-rarity">Be the first</span>; // nobody has it yet: an invitation, not a "0%"
  return rarity && <span className="achievement-rarity">{unlocked && rarity.pct <= 10 && <span className="achievement-rare">Rare</span>}{rarity.pct}% of the office</span>;
}
function Progress({ n, goal }: { n: number; goal: number }) {
  return <span className="achievement-progress"><span className="achievement-track" role="progressbar" aria-label="Achievement progress" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(n, goal)}><i style={{ width: `${Math.min(100, n / goal * 100)}%` }} /></span><span>{n}/{goal}</span></span>;
}
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function AchievementsPanel({ store, me, assets, backdrop }: { store: Store; me: ClientUser; assets: Assets | null; backdrop: HTMLAttributes<HTMLDivElement> }) {
  const panel = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), title = useId();
  const now = store.now(), today = dayNumber(now), p = me.plant, close = () => store.openAchievements(false);
  const ctx = { me, now, library: store.library }, s = summary(me, ctx), groups = sections(me, ctx);
  const dead = p && plantDead(p, now), left = p ? PLANT_DIES_DAYS - (today - p.care) : 0;
  const pct = s.total ? Math.round(s.unlocked / s.total * 100) : 0, focus = store.achievementFocus;
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else {
        const controls = document.querySelectorAll<HTMLElement>('.sb-self button, .dock button, .sb-search');
        [...controls].find(el => el.getClientRects().length > 0)?.focus();
      }
    };
  }, []);
  useEffect(() => {
    if (!focus) return;
    const card = [...(body.current?.querySelectorAll<HTMLElement>('[data-achievement]') ?? [])].find(el => el.dataset.achievement === focus);
    card?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    // Restart the moment when View targets a card in an already-open modal.
    card?.classList.remove('achievement-focus');
    if (card) { void card.offsetWidth; card.classList.add('achievement-focus'); }
    const timer = setTimeout(() => card?.classList.remove('achievement-focus'), 1600);
    return () => clearTimeout(timer);
  }, [focus]);
  return <div className="modal-backdrop" {...backdrop}>
    <div ref={panel} className="meet-panel guided achievements-panel" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="rooms-head"><span id={title}><Icon name="trophy" /> Achievements</span><IconButton icon="close" label="Close achievements" className="ghost" onClick={close} /></div>
      <div ref={body} className="achievements-body" tabIndex={0} aria-label="Achievement collection">
        <section className="achievement-summary" aria-label={`${pct}% complete`}>
          <div className="achievement-ring">
            <svg viewBox="0 0 88 88" aria-hidden="true"><circle className="ring-track" cx="44" cy="44" r="38" /><circle className="ring-arc" cx="44" cy="44" r="38" pathLength="100" style={{ strokeDashoffset: 100 - (s.total ? s.unlocked / s.total * 100 : 0) }} /></svg>
            <div><strong>{s.unlocked}/{s.total}</strong><small>unlocked</small></div>
          </div>
          <div className="achievement-summary-details"><strong className="achievement-complete">{pct}% complete</strong>
            <div className="achievement-highlights">
              {s.latest && <div className="achievement-highlight"><AchievementBadge a={s.latest.a} unlocked /><div><small>Latest</small><strong>{s.latest.a.title}</strong><span>{when(s.latest.at)}</span></div></div>}
              {s.next && <div className="achievement-highlight"><AchievementBadge a={s.next.a} /><div><small>Next up</small><strong>{s.next.a.title}</strong><Progress n={s.next.n} goal={s.next.goal} /></div></div>}
            </div>
          </div>
        </section>
        <section className="plant-card">
          {p && <PlantSprite assets={assets} plant={p} now={now} />}
          <div>
            <strong>{!p ? 'No plant yet' : dead ? 'Your plant withered' : `Your ${plantName(p)}`}</strong>
            {p && !dead && <>
              <div className="pips" aria-label={`Stage ${p.stage + 1} of ${PLANT_STAGES.length}`}>{PLANT_STAGES.map((_, i) => <i key={i} className={i <= p.stage ? 'on' : ''} />)}</div>
              <small>{PLANT_STAGES[p.stage]}{p.stage < PLANT_REVEAL ? ' · what it becomes shows at stage 4' : ''}</small>
            </>}
            <p className={p && !dead && p.care >= today ? 'ok' : 'todo'}>
              {!p ? 'Set a status to plant one.'
                : dead ? 'A week passed without a status. Set one to plant a new seedling.'
                : p.care >= today ? '✓ Watered today: it grows again tomorrow when you set a status.'
                : `💧 Set a status today to water it. It withers in ${left} day${left === 1 ? '' : 's'} without one.`}
            </p>
            <small className="muted-line">Your plant grows one stage each day you set a status, in the box at the top. It stands on your home desk, or in the Orangery if you don't have one.</small>
          </div>
        </section>
        {groups.map(group => <section key={group.id} aria-labelledby={`${title}-${group.id}`}>
          <h3 className="achievement-section-title" id={`${title}-${group.id}`}>{group.id === 'unlocked' ? 'Unlocked' : 'Locked'} · {group.items.length}</h3>
          <div className="achievement-grid">{group.items.map(a => {
            const at = me.achievements[a.id], got = at !== undefined, progress = progressOf(a, ctx);
            return <article key={a.id} data-achievement={a.id} className={`achievement-card${got ? ' got' : ''}${a.soon ? ' soon' : ''}`}>
              <AchievementBadge a={a} unlocked={got} />
              <div className="achievement-copy"><h4>{a.secret && !got ? '???' : a.title}</h4><p>{a.secret && !got ? a.secret : a.how}</p>
                {a.id === 'botanist' && me.bloomed.length > 0 && <p>Bloomed: {me.bloomed.map(kindName).join(', ')} · {PLANT_KINDS.length} kinds in all</p>}
              </div>
              <div className="achievement-footer">
                {got ? <span className="achievement-date">✓ {when(at)}</span> : a.soon ? <span>Coming soon</span> : progress ? <Progress {...progress} /> : null}
                <AchievementRarity id={a.id} store={store} unlocked={got} />
              </div>
            </article>;
          })}</div>
        </section>)}
      </div>
    </div>
  </div>;
}
