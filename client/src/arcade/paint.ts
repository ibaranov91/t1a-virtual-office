import type { Assets } from '../assets';
import { drawText, textWidth } from '../font';
import type { Store } from '../net';
import type { BaseState, PublicSession } from '../../../shared/arcade/types';
export const COLORS = ['#f08a80', '#80b8f0', '#a0d880', '#f2d060'];
export const MARKERS = ['▲', '●', '■', '◆'];
export const CHEERS = ['👏', '🔥', '😂'] as const;
export function parkTime(frames: number) { const tenths = Math.floor(frames / 6), seconds = Math.floor(tenths / 10); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`; }
export class Paint {
  constructor(readonly ctx: CanvasRenderingContext2D, readonly assets: Assets, readonly store: Store, readonly session: PublicSession, readonly state: BaseState | null) {}
  blit = (name: string, x: number, y: number) => { const f = this.assets.atlas.frames[name]; if (f) this.ctx.drawImage(this.assets.world, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h); };
  text = (label: string, x: number, y: number, color = '#fff4e0', center = false) => drawText(this.ctx, label, Math.round(center ? x - textWidth(label) / 2 : x), Math.round(y), color);
  avatar = (id: string, x: number, bottom: number, dir = 'down', frame = 0) => {
    const user = this.store.users.get(id); if (!user) return;
    const c = this.assets.atlas.character, row = c.dirs.indexOf(dir);
    this.ctx.drawImage(this.assets.sheet(user.look), frame * c.frameW, Math.max(0, row) * c.frameH, c.frameW, c.frameH, Math.round(x), Math.round(bottom - c.frameH), c.frameW, c.frameH);
  };
  player(slot: number, x: number, bottom: number, dir = 'right', frame = 0) {
    const member = this.session.view.kind === 'sim' ? this.session.view.roster.find(p => p.slot === slot) : undefined;
    const id = member?.userId ?? this.session.players.find(p => p.slot === slot)?.userId ?? '';
    this.avatar(id, x - 3, bottom, dir, frame);
    const name = this.store.name(id).split(' ')[0].slice(0, 10), w = textWidth(name);
    const nameY = bottom - 33 < 12 ? bottom + 4 : bottom - 33;
    this.ctx.fillStyle = '#29202b'; this.ctx.fillRect(Math.round(x + 5 - w / 2 - 1), Math.round(nameY - 1), w + 2, 8);
    this.text(name, x + 5, nameY, COLORS[slot], true);
    this.blit(`party_marker_${slot}`, x + 2, nameY + 7);
    if (member?.team !== null && member?.team !== undefined) { this.ctx.fillStyle = member.team === 0 ? COLORS[0] : COLORS[1]; this.ctx.fillRect(Math.round(x), Math.round(bottom + 1), 10, 2); }
  }
  banner(lines: string[]) {
    const h = lines.length * 13 + 18;
    this.ctx.fillStyle = '#21161f'; this.ctx.fillRect(8, Math.round(96 - h / 2), 304, h);
    lines.forEach((line, i) => this.text(line, 160, Math.round(105 - h / 2 + i * 13), i ? '#fff4e0' : '#f2b45a', true));
  }
  balcony() {
    const { ctx, session, store } = this;
    ctx.fillStyle = '#493744'; ctx.fillRect(0, 0, 320, 24);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 320, 24); ctx.clip();
    session.spectators.slice(0, 12).forEach((id, i) => {
      const x = 4 + i * 23; this.avatar(id, x, 23);
      const cheer = store.gameCheers.get(id);
      if (cheer && performance.now() - cheer.at < 1500) { ctx.fillStyle = '#fff8e8'; ctx.fillRect(x + 1, 0, 14, 12); ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.fillText(CHEERS[cheer.kind], x + 2, 0); }
    });
    if (!session.spectators.length) this.text('BALCONY', 160, 7, '#c5ad9d', true);
    if (session.spectators.length > 12) this.text(`+${session.spectators.length - 12}`, 285, 9);
    for (let x = 0; x < 320; x += 16) this.blit('park_railing', x, 16);
    ctx.restore();
  }
}
