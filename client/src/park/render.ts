import { LEVELS } from '../../../shared/park/levels';
import { SUB, type Rect } from '../../../shared/park/sim';
import type { Runner } from '../../../shared/park/runner';
import type { Assets } from '../assets';
import { drawText, textWidth } from '../font';
import type { ClientUser, Store } from '../net';

export const CHEERS = ['👏', '🔥', '😂'] as const;
export function parkTime(frames: number) {
  const tenths = Math.floor(frames / 6), seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`;
}

export function renderPark(ctx: CanvasRenderingContext2D, assets: Assets, runner: Runner, store: Store) {
  const view = runner.presentation, session = runner.session, state = view.state;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#292c35'; ctx.fillRect(0, 0, 320, 216);
  const blit = (name: string, x: number, y: number) => {
    const f = assets.atlas.frames[name];
    if (f) ctx.drawImage(assets.world, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h);
  };
  const text = (label: string, x: number, y: number, color = '#fff4e0', center = false) => {
    drawText(ctx, label, Math.round(center ? x - textWidth(label) / 2 : x), Math.round(y), color);
  };
  const avatar = (user: ClientUser | undefined, x: number, bottom: number, dir: string, frame: number) => {
    if (!user) return;
    const c = assets.atlas.character, row = c.dirs.indexOf(dir);
    ctx.drawImage(assets.sheet(user.look), frame * c.frameW, Math.max(0, row) * c.frameH,
      c.frameW, c.frameH, Math.round(x), Math.round(bottom - c.frameH), c.frameW, c.frameH);
  };
  const banner = (lines: string[]) => {
    const h = lines.length * 12 + 16;
    ctx.fillStyle = '#21161f'; ctx.fillRect(12, 104 - h / 2, 296, h);
    lines.forEach((line, i) => text(line, 160, 114 - h / 2 + i * 12, i ? '#fff4e0' : '#f2b45a', true));
  };

  // Balcony is independent of the scrolling game camera.
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 320, 24); ctx.clip();
  ctx.fillStyle = '#493744'; ctx.fillRect(0, 0, 320, 24);
  const spectators = session?.spectators ?? [];
  spectators.slice(0, 12).forEach((id, i) => {
    const x = 4 + i * 23;
    avatar(store.users.get(id), x, 23, 'down', 0);
    const cheer = store.gameCheers.get(id);
    if (cheer && performance.now() - cheer.at < 1500) {
      ctx.fillStyle = '#fff8e8'; ctx.fillRect(x + 1, 0, 14, 12);
      ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.fillText(CHEERS[cheer.kind], x + 2, 0);
    }
  });
  if (spectators.length > 12) text(`+${spectators.length - 12}`, 285, 9);
  if (!spectators.length) text('BALCONY', 160, 7, '#c5ad9d', true);
  for (let x = 0; x < 320; x += 16) blit('park_railing', x, 16);
  ctx.restore();
  if (!session || !state) { banner(['Joining…']); return; }
  const level = LEVELS[session.level], cam = Math.floor(state.camX / SUB);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 24, 320, 192); ctx.clip(); ctx.translate(-cam, 24);
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
  if (session.level) {
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
  if (level.lobby) {
    const { start, selectors } = level.lobby;
    for (let x = 0; x < start.w; x++) blit('park_start', (start.x + x) * 16, start.y * 16);
    text('START', (start.x + start.w / 2) * 16, start.y * 16 + 5, '#fff4e0', true);
    ctx.fillStyle = '#3a2329'; ctx.fillRect(start.x * 16, start.y * 16 - 5, start.w * 16, 3);
    ctx.fillStyle = '#8cc864'; ctx.fillRect(start.x * 16, start.y * 16 - 5, start.w * 16 * Math.min(60, state.startHold) / 60, 3);
    selectors.forEach(r => { for (let x = 0; x < r.w; x++) blit(`park_select_${r.delta < 0 ? 'left' : 'right'}`, (r.x + x) * 16, r.y * 16); });
    const selected = LEVELS[state.selected], team = session.players.length as 1 | 2 | 3 | 4;
    const record = store.arcadeRecords[state.selected]?.[team];
    text(`${selected.id}. ${selected.name}`, 160, 48, '#f2b45a', true);
    text(record ? `BEST ${parkTime(record.frames)} · ${record.coins} COINS` : `NO RECORD YET · TEAM ${team}`, 160, 60, '#fff4e0', true);
    text('ALL ON START TO PLAY', 160, 76, '#c5d6c0', true);
  }
  state.players.forEach((p, slot) => {
    if (!p.present || p.dead || p.entered) return;
    const user = store.users.get(session.players.find(m => m.slot === slot)?.userId ?? '');
    const x = Math.round(p.x / SUB) - 3, bottom = Math.round(p.y / SUB) + 20;
    if (state.key.carrier === slot && !state.doorOpen) blit('park_key', x + (p.facing > 0 ? -10 : 10), bottom - 24);
    avatar(user, x, bottom, p.facing < 0 ? 'left' : 'right', !p.grounded ? 1 : p.vx ? 1 + Math.floor(state.frame / 7) % 4 : 0);
    const name = user?.name.split(' ')[0].slice(0, 10) ?? '…', w = textWidth(name);
    ctx.fillStyle = '#29202b'; ctx.fillRect(x + 8 - Math.ceil(w / 2) - 1, bottom - 32, w + 2, 7);
    text(name, x + 8, bottom - 31, user?.id === store.me ? '#ffe08a' : '#fff4e0', true);
  });
  ctx.restore();
  ctx.fillStyle = '#29202b'; ctx.fillRect(0, 24, 320, 11);
  text(level.name, 4, 27, '#f2b45a');
  text(parkTime(state.cleared ? state.clearedAt : state.frame), 224, 27);
  text(`${state.coins} COINS`, 274, 27);
  if (view.countdown) banner([String(view.countdown)]);
  if (view.clear) banner(['CLEAR!', `${parkTime(view.clear.frames)} · ${view.clear.coins} coins`, ...(view.clear.record ? ['New record!'] : [])]);
}
