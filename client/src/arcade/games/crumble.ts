import type { CrumbleState } from '../../../../shared/arcade/games/crumble';
import { SUB } from '../../../../shared/arcade/arena';
import { Paint } from '../paint';
export function renderCrumble(p: Paint, s: CrumbleState) {
  const { ctx, blit, text } = p;
  ctx.fillStyle = '#3b3449'; ctx.fillRect(0, 0, 320, 192);
  for (const tile of s.tiles) if (!tile.gone) blit(tile.crackAt < 0 ? 'party_crumble' : s.frame - tile.crackAt < 15 ? 'party_crumble_crack_1' : 'party_crumble_crack_2', tile.x * 16, tile.y * 16);
  for (const [slot, player] of s.players.entries()) if (player.present && player.alive) {
    p.player(slot, player.x / SUB, player.y / SUB + 20, player.facing < 0 ? 'left' : 'right', player.vx || !player.grounded ? 1 + Math.floor(s.frame / 7) % 4 : 0);
    if (s.pounding[slot]) blit('party_pound', player.x / SUB - 3, player.y / SUB + 18);
  }
  ctx.fillStyle = '#21161f'; ctx.fillRect(0, 0, 320, 11);
  text('CRUMBLE TOWER', 4, 3, '#f2b45a'); text(`${Math.max(0, 90 - Math.floor(s.frame / 60))}s`, 294, 3);
}
