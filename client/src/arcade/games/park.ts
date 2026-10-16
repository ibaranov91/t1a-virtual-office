import { LEVELS } from '../../../../shared/park/levels';
import { SUB, type Rect } from '../../../../shared/park/sim';
import { HUB_LEVEL, type HubState } from '../../../../shared/arcade/hub';
import type { ParkGameState } from '../../../../shared/arcade/games/park';
import type { ParkState } from '../../../../shared/park/sim';
import { Paint, parkTime } from '../paint';
import { drawHub } from './hub';
export function renderPark(paint: Paint, state: ParkGameState | ParkState, hub = false) {
  const { ctx, blit, text } = paint;
  const level = hub ? HUB_LEVEL : LEVELS[(state as ParkGameState).level], cam = Math.floor(state.camX / SUB);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 320, 192); ctx.clip(); ctx.translate(-cam, 0);
  ctx.fillStyle = '#3d4e52'; ctx.fillRect(cam, 0, 320, 192);
  for (let y = 0; y < 12; y++) for (let x = Math.max(0, Math.floor(cam / 16)); x < Math.min(level.width, Math.ceil((cam + 320) / 16)); x++) {
    const c = level.rows[y][x];
    const name = c === '#' ? y === 0 || level.rows[y - 1][x] !== '#' ? 'ground' : 'dirt'
      : c === 'B' ? 'brick' : c === '=' ? 'oneway' : c === '^' ? 'spikes' : null;
    if (name) blit(`park_${name}`, x * 16, y * 16);
  }
  const at = (name: string, r: { x: number; y: number }) => blit(name, r.x / SUB, r.y / SUB);
  const labelNeed = (r: Rect & { need: number | 'all' }) => {
    const count = state.players.filter(p => p.present).length;
    text(String(r.need === 'all' ? count : Math.min(r.need, count)), r.x / SUB + r.w / SUB / 2, r.y / SUB + 5, '#fff4e0', true);
  };
  level.sDefs.forEach((r, i) => at(`park_s_${state.sBlocks[i] ? 'solid' : 'ghost'}`, r));
  level.tDefs.forEach((r, i) => at(`park_t_${state.tBlocks[i] ? 'solid' : 'ghost'}`, r));
  level.gateDefs.forEach((r, i) => { if (!state.gates[i].open) at('park_gate', r); });
  level.buttonDefs.forEach((r, i) => { at(`park_button_${state.buttons[i].pressed ? 'down' : 'up'}`, r); labelNeed(r); });
  level.flags.forEach(r => at(`park_flag_${r.x === state.checkpoint.x && r.y === state.checkpoint.y ? 'up' : 'down'}`, { x: r.x, y: r.y - 4 * SUB }));
  level.coinDefs.forEach((r, i) => { if (!state.coinsTaken[i]) at(`park_coin_${1 + Math.floor(state.frame / 8) % 4}`, r); });
  if (!hub) {
    at(`park_door_${state.doorOpen ? 'open' : 'closed'}`, level.door);
    const outside = state.players.filter(p => p.present && !p.entered).length;
    text(String(outside), level.door.x / SUB + 8, level.door.y / SUB - 7, '#f2b45a', true);
    if (state.key.carrier === -1) at('park_key', state.key);
  }
  state.boxes.forEach((r, i) => { at('park_box', r); labelNeed({ ...level.boxDefs[i], ...r }); });
  const platform = (kind: string, r: Rect) => {
    for (let x = 0; x < r.w / SUB; x += 16) blit(`park_${kind}_${x === 0 ? 'left' : x + 16 >= r.w / SUB ? 'right' : 'middle'}`, r.x / SUB + x, r.y / SUB);
  };
  state.lifts.forEach((v, i) => {
    const r = { ...level.liftDefs[i], y: level.liftDefs[i].y + v.offset };
    platform('lift', r); labelNeed(r);
  });
  state.movers.forEach((v, i) => platform('platform', { ...level.moverDefs[i], x: level.moverDefs[i].x + v.offset.x, y: level.moverDefs[i].y + v.offset.y }));
  state.enemies.forEach(e => { if (e.alive) at(`park_walker_${1 + Math.floor(state.frame / 10) % 2}`, e); });
  if (hub) drawHub(paint, state as HubState);
  state.players.forEach((p, slot) => {
    if (!p.present || p.dead || p.entered) return;
    const x = Math.round(p.x / SUB), bottom = Math.round(p.y / SUB) + 20;
    if (state.key.carrier === slot && !state.doorOpen) blit('park_key', x + (p.facing > 0 ? -10 : 10), bottom - 24);
    paint.player(slot, x, bottom, p.facing < 0 ? 'left' : 'right', !p.grounded ? 1 : p.vx ? 1 + Math.floor(state.frame / 7) % 4 : 0);
  });
  ctx.restore();
  ctx.fillStyle = '#29202b'; ctx.fillRect(0, 0, 320, 11);
  text(level.name, 4, 3, '#f2b45a');
  if (!level.lobby) { // the lobby has no clock and no coins
    text(parkTime(state.cleared ? state.clearedAt : state.frame), 224, 3);
    text(`${state.coins} COINS`, 274, 3);
  }
}
