import { gameDef } from '../../../shared/arcade/registry';
import { BONUS_LABELS } from '../../../shared/arcade/scoring';
import type { ScreenView } from '../../../shared/arcade/types';
import { Paint, parkTime } from './paint';
export function renderScreen(p: Paint, screen: ScreenView, now: number) {
  const { ctx, text, blit, store } = p, d = screen.data;
  ctx.fillStyle = '#354448'; ctx.fillRect(0, 0, 320, 192);
  const name = (id: string) => store.name(id).slice(0, 18);
  const clock = () => text(`${Math.max(0, Math.ceil((screen.until - now) / 1000))}s`, 296, 180, '#c5d6c0', true);
  if (screen.screen === 'title' && d.game) {
    const game = gameDef(d.game);
    text(`ROUND ${d.round}/3${d.round === 3 ? ' · FINAL x2' : ''}`, 160, 16, '#f2b45a', true);
    blit(`party_card_${d.game}`, 144, 42); text(game.name, 160, 86, '#fff4e0', true);
    const words = game.goal.split(' '), lines = [''];
    for (const word of words) { if ((lines.at(-1)!.length + word.length) > 44) lines.push(''); lines[lines.length - 1] += `${lines.at(-1) ? ' ' : ''}${word}`; }
    lines.forEach((line, i) => text(line, 160, 102 + i * 10, '#c5d6c0', true));
    game.controls.forEach((control, i) => { const x = 160 + (i - (game.controls.length - 1) / 2) * 72; blit(`party_control_${control}`, x - 8, 141); text(control.toUpperCase(), x, 161, '#f2b45a', true); });
  } else if (screen.screen === 'scores') {
    if (d.clear) { p.banner(['CLEAR!', `${parkTime(d.clear.frames)} · ${d.clear.coins} COINS`, ...(d.clear.record ? ['NEW RECORD!'] : [])]); clock(); return; }
    text(d.result?.final ? 'FINAL ROUND SCORES · x2' : 'ROUND SCORES', 160, 12, '#f2b45a', true);
    let place = 1, row = 0;
    for (const group of d.result?.order ?? []) {
      for (const id of group) {
        text(`${place}. ${name(id)}`, 16, 39 + row * 22);
        text(`+${d.result!.points[id] ?? 0}   TOTAL ${d.totals?.[id] ?? 0}`, 166, 39 + row * 22, '#f2b45a');
        if (d.result?.underdog.includes(id)) text('UNDERDOG +1', 166, 48 + row * 22, '#a0d880'); row++;
      }
      place += group.length;
    }
    text('CORRECT PREDICTIONS', 160, 140, '#c5d6c0', true);
    text(d.predictions?.length ? d.predictions.map(name).join(', ').slice(0, 48) : 'No correct predictions this round', 160, 153, '#fff4e0', true);
  } else if (screen.screen === 'favourite') {
    blit('party_favourite', 152, 14); text('CROWD FAVOURITE', 160, 40, '#f2b45a', true);
    text('SPECTATORS: TAP A PLAYER BELOW · +1', 160, 55, '#c5d6c0', true);
    d.candidates?.forEach((id, i) => { p.avatar(id, 34, 91 + i * 22); text(name(id), 58, 76 + i * 22); text(`${d.votes?.[id] ?? 0} VOTES`, 222, 76 + i * 22, '#f2b45a'); });
  } else if (screen.screen === 'bonus') {
    blit('party_star', 152, 23); text('BONUS STAR', 160, 49, '#f2b45a', true);
    text(d.bonus ? BONUS_LABELS[d.bonus.category] ?? d.bonus.category : 'NO STAR THIS SET', 160, 70, '#fff4e0', true);
    d.bonus?.winners.forEach((id, i) => text(`${name(id)} +2 · TOTAL ${d.totals?.[id]}`, 160, 88 + i * 12, '#f2b45a', true));
    text(d.favourite?.length ? `FAVOURITE +1: ${d.favourite.map(name).join(', ')}`.slice(0, 48) : 'NO CROWD FAVOURITE', 160, 154, '#c5d6c0', true);
  } else if (screen.screen === 'awards') {
    text('BREAK SET · AWARDS', 160, 10, '#f2b45a', true);
    const order = d.standings ?? []; let rank = 1, row = 0;
    for (const group of order) {
      for (const id of group) {
        const y = 29 + row * 38; ctx.fillStyle = '#21161f'; ctx.fillRect(8, y, 304, 34);
        p.avatar(id, 14, y + 28); blit('party_award', 296, y + 3);
        text(`${rank}. ${name(id)} · ${d.totals?.[id] ?? 0} POINTS`, 36, y + 4, '#f2b45a');
        (d.awards?.[id] ?? []).forEach((award, i) => text(award, 36, y + 14 + i * 9)); row++;
      }
      rank += group.length;
    }
  }
  clock();
}
