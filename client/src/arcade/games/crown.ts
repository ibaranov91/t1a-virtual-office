import { CROWN_LAYOUTS, type CrownState } from '../../../../shared/arcade/games/crown';
import { SUB } from '../../../../shared/arcade/arena';
import { Paint, COLORS } from '../paint';
export function renderCrown(p: Paint, s: CrownState) {
  const { ctx, blit, text } = p;
  ctx.fillStyle = '#344b50'; ctx.fillRect(0, 0, 320, 192);
  for (const r of CROWN_LAYOUTS[s.layout]) for (let x = 0; x < r.w / SUB; x += 16) blit('party_platform', r.x / SUB + x, r.y / SUB);
  if (s.holder < 0 && !s.returnIn) blit('party_stapler', 153, 108);
  s.players.forEach((player, slot) => {
    if (!player.present || !player.alive) return;
    const x = player.x / SUB, y = player.y / SUB;
    if (s.dash[slot]) blit('party_tackle', x - (player.facing > 0 ? 14 : -4), y + 8);
    p.player(slot, x, y + 20, player.facing < 0 ? 'left' : 'right', player.vx || !player.grounded ? 1 + Math.floor(s.frame / 7) % 4 : 0);
    if (s.holder === slot) { blit('party_stapler', x - 3, y - 16); if (s.immune) { ctx.strokeStyle = '#ffe08a'; ctx.strokeRect(Math.round(x - 2), Math.round(y - 2), 14, 24); } }
    if (s.stun[slot]) blit('party_star', x - 2, y - 10);
  });
  ctx.fillStyle = '#21161f'; ctx.fillRect(0, 0, 320, 12);
  s.roster.forEach((r, i) => text(`${i + 1}: ${Math.trunc((s.players[r.slot].stats.holdFrames ?? 0) / 60)}/20`, 4 + i * 68, 3, COLORS[r.slot]));
  text(`${Math.max(0, 90 - Math.floor(s.frame / 60))}s`, 292, 3);
  if (s.roster[0]?.team !== null) for (const team of [0, 1]) {
    const hold = s.roster.filter(r => r.team === team).reduce((n, r) => n + (s.players[r.slot].stats.holdFrames ?? 0), 0);
    text(`${team === 0 ? 'RED' : 'BLUE'} ${Math.trunc(hold / 60)}/20`, team ? 245 : 45, 17, COLORS[team], true);
  }
}
