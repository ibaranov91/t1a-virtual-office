import type { Runner } from '../../../shared/arcade/runner';
import type { HubState } from '../../../shared/arcade/hub';
import type { VoteState } from '../../../shared/arcade/vote';
import type { ParkGameState } from '../../../shared/arcade/games/park';
import type { CrumbleState } from '../../../shared/arcade/games/crumble';
import type { CrownState } from '../../../shared/arcade/games/crown';
import type { Assets } from '../assets';
import type { Store } from '../net';
import { Paint } from './paint';
import { renderPark } from './games/park';
import { renderVote } from './games/vote';
import { renderCrumble } from './games/crumble';
import { renderCrown } from './games/crown';
import { renderScreen } from './screens';
export function renderArcade(ctx: CanvasRenderingContext2D, assets: Assets, runner: Runner, store: Store) {
  const session = runner.session; ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#21161f'; ctx.fillRect(0, 0, 320, 216); if (!session) return;
  const state = runner.presentation.state, p = new Paint(ctx, assets, store, session, state); p.balcony();
  ctx.save(); ctx.beginPath(); ctx.rect(0, 24, 320, 192); ctx.clip(); ctx.translate(0, 24);
  if (session.view.kind === 'screen') renderScreen(p, session.view, runner.serverNow);
  else if (!state) p.banner(['Joining…']);
  else {
    switch (session.view.game) {
      case 'hub': renderPark(p, state as HubState, true); break;
      case 'park': renderPark(p, state as ParkGameState); break;
      case 'vote': renderVote(p, state as VoteState); break;
      case 'crumble': renderCrumble(p, state as CrumbleState); break;
      case 'crown': renderCrown(p, state as CrownState); break;
    }
    if (runner.presentation.countdown) p.banner([String(runner.presentation.countdown)]);
  }
  ctx.restore();
}
