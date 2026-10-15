#!/usr/bin/env node
// Run with: node --import tsx scripts/park-replay.mjs <level> <team> [--every 30] [--script file.json]
import { readFileSync } from 'node:fs';
import { LEVELS } from '../shared/park/levels.ts';
import { SOLUTIONS, LOBBY_SOLUTIONS } from '../shared/park/solutions.ts';
import { parkInit, parkStep, SUB, PLAYER_H } from '../shared/park/sim.ts';

const args = process.argv.slice(2), level = Number(args[0]), team = Number(args[1]);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const every = Number(option('--every', 30)), file = option('--script');
if (!Number.isInteger(level) || level < 0 || level > 8 || !Number.isInteger(team) || team < 1 || team > 4 || !Number.isInteger(every) || every < 1) {
  console.error('Usage: node --import tsx scripts/park-replay.mjs <0..8> <1..4> [--every 30] [--script file.json]'); process.exit(1);
}
const script = file ? JSON.parse(readFileSync(file, 'utf8')) : level ? SOLUTIONS[level]?.[team] : LOBBY_SOLUTIONS[team];
if (!script || !Number.isInteger(script.frames) || script.frames > 7200 || !Array.isArray(script.inputs)) throw new Error('missing/invalid recorded script');
const l = LEVELS[level], s = parkInit(l), joins = Array.from({ length: team }, (_, slot) => [0, slot, 1, 0]);
let deaths = 0, index = 0;
const print = () => console.log(`f=${s.frame} p=${s.players.flatMap((p, slot) => p.present ? [`${slot}:${p.entered ? 'in' : `${p.x / SUB},${(p.y + PLAYER_H) / SUB}${p.dead ? '†' : ''}`}`] : []).join(' ')} key=${s.key.carrier}@${s.key.x / SUB},${s.key.y / SUB} door=${s.doorOpen} deaths=${deaths} coins=${s.coins}${level === 0 ? ` selected=${s.selected} hold=${s.startHold}` : ''}`);
for (let f = 0; f < script.frames; f++) {
  const events = f === 0 ? [...joins] : [];
  while (index < script.inputs.length && script.inputs[index][0] === f) { const [frame, slot, bits] = script.inputs[index++]; events.push([frame, slot, 0, bits]); }
  parkStep(s, l, events); deaths += s.fx.filter(fx => fx.kind === 'death').length;
  if (f % every === 0 || s.cleared || s.startReady || f === script.frames - 1) print();
  if (s.cleared || s.startReady) break;
}
console.log(level === 0 ? `startReady=${s.startReady}` : `cleared=${s.cleared} clearedAt=${s.clearedAt}`);
if (!(level === 0 ? s.startReady : s.cleared)) process.exitCode = 1;
