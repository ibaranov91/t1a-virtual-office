import type { VoteState } from '../../../../shared/arcade/vote';
import { gameDef } from '../../../../shared/arcade/registry';
import { Paint, COLORS } from '../paint';
export function renderVote(p: Paint, s: VoteState) {
  const { ctx, blit, text } = p, width = Math.trunc(300 / s.ballot.length);
  ctx.fillStyle = '#354448'; ctx.fillRect(0, 0, 320, 192);
  text(`PICK ROUND ${p.session.set?.round ?? 1}/3`, 160, 12, '#f2b45a', true);
  text(`${Math.max(0, Math.ceil((480 - s.frame) / 60))} SECONDS · LEFT / RIGHT + JUMP`, 160, 27, '#c5d6c0', true);
  s.ballot.forEach((card, i) => {
    const x = 10 + i * width;
    ctx.fillStyle = '#21161f'; ctx.fillRect(x + 2, 48, width - 6, 102);
    blit(`party_card_${card.game}`, x + Math.trunc(width / 2) - 16, 59);
    const label = card.game === 'surprise' ? 'Surprise' : gameDef(card.resolves).name;
    const words = label.split(' ');
    words.forEach((word, row) => text(word, x + width / 2, 98 + row * 9, '#fff4e0', true));
    s.players.forEach((player, slot) => {
      if (!player.present) return;
      if (player.cursor === i) { blit(`party_marker_${slot}`, x + 9 + slot * 18, 136); text(player.confirmed === i ? '+' : '?', x + 16 + slot * 18, 135, COLORS[slot]); }
      if (player.confirmed === i) blit(`party_marker_${slot}`, x + 9 + slot * 18, 119);
    });
  });
  text('YOU CAN CHANGE YOUR VOTE UNTIL THE BELL', 160, 168, '#c5d6c0', true);
}
