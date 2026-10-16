import type { ScreenRunState } from '../../../../shared/arcade/games/screenrun';
import { SUB } from '../../../../shared/arcade/arena';
import { Paint, COLORS } from '../paint';
export function renderScreenRun(p: Paint, s: ScreenRunState) {
  const { ctx, blit, text } = p, cam = Math.floor(s.camX / SUB);
  ctx.fillStyle = ['#36485c','#4d3b50','#3a5150'][s.layout]; ctx.fillRect(0,0,320,192);
  for (let x = -cam % 48; x < 320; x += 48) { blit('party_run_window', x, 28); blit('party_run_window', x + 16, 60); }
  for (let col = Math.max(0,Math.trunc(cam / 16)); col <= Math.trunc((cam + 320) / 16); col++) {
    const row = s.course[col]; if (row === undefined || row < 0) continue;
    const x = col * 16 - cam; ctx.fillStyle = '#4e5662'; ctx.fillRect(x, row * 16 + 5, 16, 192 - row * 16);
    blit('party_run_floor', x, row * 16);
  }
  s.players.forEach((q,slot) => {
    if (!q.present || !q.alive) return;
    const x = q.x / SUB - cam, y = q.y / SUB;
    if (s.dash[slot]) blit('party_run_dash', x - 18, y + 8);
    p.player(slot,x,y + 20,q.facing < 0 ? 'left' : 'right',q.vx || !q.grounded ? 1 + Math.floor(s.frame / 6) % 4 : 0);
    if (s.push[slot]) blit('party_pound',x - 3,y + 18);
  });
  ctx.fillStyle = '#f08a80'; ctx.fillRect(0,12,2,180);
  ctx.fillStyle = '#21161f'; ctx.fillRect(0,0,320,12);
  s.roster.forEach((r,i) => text(`${r.slot + 1}:${s.points[r.slot]}/3 ${s.players[r.slot].alive ? s.cooldown[r.slot] ? 'WAIT' : 'DASH' : 'OUT'}`,3 + i * 70,3,COLORS[r.slot]));
  text(`${Math.max(0,150 - Math.floor(s.frame / 60))}s`,292,3);
}
