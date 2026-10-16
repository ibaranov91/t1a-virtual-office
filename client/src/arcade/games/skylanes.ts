import type { SkyLanesState } from '../../../../shared/arcade/games/skylanes';
import { SUB } from '../../../../shared/arcade/arena';
import { Paint, COLORS } from '../paint';
export function renderSkyLanes(p: Paint, s: SkyLanesState) {
  const { ctx,blit,text } = p, left = Math.trunc((320 - s.roster.length * 80) / 2);
  ctx.fillStyle = '#263746'; ctx.fillRect(0,0,320,192);
  s.roster.forEach((r,i) => {
    const slot = r.slot, q = s.players[slot], x = left + i * 80, cam = Math.floor(s.cams[slot] / SUB);
    ctx.save(); ctx.beginPath(); ctx.rect(x,0,80,192); ctx.clip(); ctx.translate(x,0);
    ctx.fillStyle = i % 2 ? '#3b5669' : '#344e63'; ctx.fillRect(0,0,80,192);
    for (let y = (-cam % 48 + 48) % 48; y < 192; y += 48) blit('party_sky_cloud',12 + i % 2 * 28,y);
    for (const [index,t] of s.platforms.entries()) {
      const y = t.y / SUB - cam; if (y < -8 || y > 192 || s.broken[slot].includes(index)) continue;
      blit(`party_sky_${t.kind}`,s.moving[index] / SUB,y);
    }
    if (176 - cam < 192) { ctx.fillStyle = '#799a87'; ctx.fillRect(0,176 - cam,80,16); }
    if (q.present && q.alive) for (const offset of [0,-80]) p.player(slot,q.x / SUB + offset,q.y / SUB + 20 - cam,q.facing < 0 ? 'left' : 'right',1 + Math.floor(s.frame / 8) % 4);
    ctx.fillStyle = '#21161f'; ctx.fillRect(0,0,80,17);
    text(`${slot + 1}: ${Math.trunc((q.stats.height ?? 0) / SUB)}px`,40,3,COLORS[slot],true);
    text(!q.present || !q.alive ? 'OUT' : 'CLIMB!',40,11,!q.alive ? '#f08a80' : '#c5d6c0',true);
    ctx.fillStyle = COLORS[slot]; ctx.fillRect(0,17,1,175); ctx.restore();
  });
  text(`${Math.max(0,90 - Math.floor(s.frame / 60))}s`,160,181,'#fff4e0',true);
}
