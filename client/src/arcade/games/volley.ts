import type { VolleyState } from '../../../../shared/arcade/games/volley';
import { SUB } from '../../../../shared/arcade/arena';
import { Paint, COLORS } from '../paint';
export function renderVolley(p: Paint, s: VolleyState) {
  const { ctx,blit,text } = p;
  ctx.fillStyle = ['#385351','#3b495e','#514253'][s.layout]; ctx.fillRect(0,0,320,192);
  for (let x = 8; x < 320; x += 32) blit('party_run_window',x,35);
  ctx.fillStyle = '#716158'; ctx.fillRect(0,176,320,16);
  for (let x = 0; x < 320; x += 16) blit('party_volley_floor',x,176);
  for (let y = 128; y < 176; y += 16) blit('party_volley_net',158,y);
  s.players.forEach((q,slot) => { if (q.present) p.player(slot,q.x / SUB,q.y / SUB + 20,q.facing < 0 ? 'left' : 'right',q.vx || !q.grounded ? 1 + Math.floor(s.frame / 7) % 4 : 0); });
  blit('party_volley_ball',s.ball.x / SUB,s.ball.y / SUB);
  for (const fx of s.fx) if (fx.kind === 'volleyspike') blit('party_volley_impact',s.ball.x / SUB - 4,s.ball.y / SUB - 4);
  ctx.fillStyle = '#21161f'; ctx.fillRect(0,0,320,24);
  text(`RED ${s.points[0]}/7`,65,4,COLORS[0],true); text(`BLUE ${s.points[1]}/7`,255,4,COLORS[1],true);
  text(`${s.touches[0]}/3 TOUCHES`,65,15,'#c5d6c0',true); text(`${s.touches[1]}/3 TOUCHES`,255,15,'#c5d6c0',true);
  text(s.frame >= 5400 ? 'GOLDEN POINT' : `${90 - Math.floor(s.frame / 60)}s`,160,8,'#f2b45a',true);
}
