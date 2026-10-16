import { QUIVER_LAYOUTS, QUIVER_SPIKES, type QuiverState } from '../../../../shared/arcade/games/quiver';
import { SUB } from '../../../../shared/arcade/arena';
import { Paint, COLORS } from '../paint';
export function renderQuiver(p: Paint, s: QuiverState) {
  const { ctx, blit, text } = p;
  ctx.fillStyle = ['#303c50', '#40364e', '#314b47'][s.layout]; ctx.fillRect(0,0,320,192);
  for (const r of QUIVER_LAYOUTS[s.layout]) for (let x = 0; x < r.w / SUB; x += 16) blit('party_quiver_stone', r.x / SUB + x, r.y / SUB);
  for (const a of s.arrows) {
    ctx.save(); ctx.translate(Math.round(a.x / SUB + 1), Math.round(a.y / SUB + 1)); ctx.rotate(Math.atan2(a.vy, a.vx)); blit(a.stuck ? 'party_arrow_stuck' : 'party_arrow', -5, -2); ctx.restore();
  }
  s.players.forEach((q, slot) => {
    if (!q.present || !q.alive) return;
    for (const dx of [0, -320]) for (const dy of s.heatFrame < QUIVER_SPIKES ? [0, -192] : [0]) {
      p.player(slot, q.x / SUB + dx, q.y / SUB + 20 + dy, q.facing < 0 ? 'left' : 'right', q.vx || !q.grounded ? 1 + Math.floor(s.frame / 7) % 4 : 0);
      ctx.save(); ctx.translate(Math.round(q.x / SUB + 5 + dx), Math.round(q.y / SUB + 10 + dy)); ctx.scale(q.facing, 1); blit('party_bow', 2, -6); ctx.restore();
    }
  });
  if (s.heatFrame >= QUIVER_SPIKES) {
    const y = Math.max(12, 192 - Math.trunc((s.heatFrame - QUIVER_SPIKES) / 4));
    ctx.fillStyle = '#802e44'; ctx.fillRect(0, y + 5, 320, 192 - y);
    for (let x = 0; x < 320; x += 16) blit('party_quiver_spikes', x, y);
  }
  ctx.fillStyle = '#21161f'; ctx.fillRect(0,0,320,12);
  s.roster.forEach((r,i) => text(`${r.slot + 1}:${s.points[r.slot]}/3 A:${s.ammo[r.slot]}${s.players[r.slot].alive ? '' : ' OUT'}`, 3 + i * 70, 3, COLORS[r.slot]));
  text(`${Math.max(0,150 - Math.floor(s.frame / 60))}s`, 292,3);
  if (s.heatFrame >= QUIVER_SPIKES - 180 && s.heatFrame < QUIVER_SPIKES) text('SPIKES RISING SOON',160,18,'#f08a80',true);
}
