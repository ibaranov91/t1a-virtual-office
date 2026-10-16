import { TRAILS_W, TRAILS_H, type TrailsState } from '../../../../shared/arcade/games/trails';
import { Paint, COLORS } from '../paint';
export function renderTrails(p: Paint, s: TrailsState) {
  const { ctx,blit,text } = p;
  ctx.fillStyle = '#202e3b'; ctx.fillRect(0,0,320,192);
  ctx.strokeStyle = '#2c3b4b'; ctx.lineWidth = 1;
  for (let x = 0; x < 320; x += 20) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,190); ctx.stroke(); }
  for (let y = 0; y < 190; y += 20) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(320,y); ctx.stroke(); }
  for (let y = 0; y < TRAILS_H; y++) for (let x = 0; x < TRAILS_W; x++) {
    if (!x || !y || x === TRAILS_W - 1 || y === TRAILS_H - 1) { ctx.fillStyle = '#536176'; ctx.fillRect(x * 5,y * 5,5,5); }
    else if (s.grid[y * TRAILS_W + x]) blit(`party_trail_${s.grid[y * TRAILS_W + x] - 1}`,x * 5,y * 5);
  }
  s.players.forEach((q,slot) => {
    if (!q.present || !q.alive) return;
    ctx.save(); ctx.translate(q.x * 5 + 2,q.y * 5 + 2); ctx.rotate(s.dir[slot] * Math.PI / 2); blit(`party_bike_${slot}`,-3,-2); ctx.restore();
    const member = s.roster.find(r => r.slot === slot), name = p.store.name(member?.userId ?? '').split(' ')[0].slice(0,8), x = Math.max(20,Math.min(300,q.x * 5)), y = q.y > 4 ? q.y * 5 - 10 : q.y * 5 + 8;
    text(name,x,y,COLORS[slot],true); blit(`party_marker_${slot}`,x - 3,y + 5);
    ctx.fillStyle = '#21161f'; ctx.fillRect(q.x * 5 - 4,q.y * 5 + 6,14,2); ctx.fillStyle = COLORS[slot]; ctx.fillRect(q.x * 5 - 4,q.y * 5 + 6,Math.trunc(14 * s.boost[slot] / 90),2);
  });
  ctx.fillStyle = '#21161f'; ctx.fillRect(0,0,320,5);
  s.roster.forEach((r,i) => text(`${r.slot + 1}:${s.points[r.slot]}/6${s.players[r.slot].alive ? '' : ' OUT'}`,6 + i * 70,0,COLORS[r.slot]));
  text(`${Math.max(0,150 - Math.floor(s.frame / 60))}s`,292,0);
}
