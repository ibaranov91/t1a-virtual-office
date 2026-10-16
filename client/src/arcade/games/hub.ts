import { LEVELS } from '../../../../shared/park/levels';
import { HUB_LEVEL, PARTY_PAD, COOP_PAD, type HubState } from '../../../../shared/arcade/hub';
import { Paint, parkTime } from '../paint';
export function drawHub(p: Paint, s: HubState) {
  const { ctx, blit, text, session, store } = p, count = s.players.filter(p => p.present).length;
  for (const [pad, label, hold, enabled] of [[PARTY_PAD, 'PARTY', s.partyHold, count >= 2], [COOP_PAD, 'CO-OP', s.startHold, true]] as const) {
    for (let x = 0; x < pad.w; x++) blit(enabled ? 'party_pad' : 'party_pad_off', (pad.x + x) * 16, pad.y * 16);
    text(label, (pad.x + pad.w / 2) * 16, pad.y * 16 + 5, enabled ? '#fff4e0' : '#c5ad9d', true);
    if (!enabled) text('2+ PLAYERS', (pad.x + pad.w / 2) * 16, pad.y * 16 - 14, '#c5ad9d', true);
    ctx.fillStyle = '#29202b'; ctx.fillRect(pad.x * 16, pad.y * 16 - 5, pad.w * 16, 3);
    ctx.fillStyle = '#8cc864'; ctx.fillRect(pad.x * 16, pad.y * 16 - 5, Math.trunc(pad.w * 16 * hold / 60), 3);
  }
  HUB_LEVEL.lobby!.selectors.forEach(r => {
    if (r.kind === 'mode' && count !== 4) return;
    for (let x = 0; x < r.w; x++) blit(r.kind === 'crew' ? 'party_crew_sign' : r.kind === 'mode' ? 'party_mode' : `park_select_${r.delta < 0 ? 'left' : 'right'}`, (r.x + x) * 16, r.y * 16);
  });
  const exit = HUB_LEVEL.lobby!.exit;
  blit('park_door_open', exit.x * 16, exit.y * 16); text('EXIT', exit.x * 16 + 7, exit.y * 16 - 9, '#f2b45a', true);
  text(session.crew.name, 160, 23, '#f2b45a', true);
  text(count === 4 ? s.teamMode ? '2v2 · RED / BLUE' : 'FREE FOR ALL' : `${count} PLAYER${count === 1 ? '' : 'S'}`, 160, 36, '#c5d6c0', true);
  const level = LEVELS[s.selected], record = store.arcadeRecords[s.selected]?.[session.players.length as 1 | 2 | 3 | 4];
  text(`CO-OP: ${level.id}. ${level.name}`, 160, 52, '#fff4e0', true);
  text(record ? `BEST ${parkTime(record.frames)} · ${record.coins} COINS` : 'NO CO-OP RECORD YET', 160, 64, '#c5d6c0', true);
  text('BUMP THE SIGN TO REROLL YOUR CREW', 160, 85, '#c5d6c0', true);
}
