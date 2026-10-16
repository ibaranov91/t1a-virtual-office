import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { applyEdit, layoutProblem, routes, type TileMap } from '../../shared/map';
const base: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('all three personal timer objects are clickable and appear in existing saved offices', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 100_000 });
  const map = structuredClone(base), world = new World(map);
  const old = structuredClone(base.objects.filter(o => o.use?.kind !== 'wellness'));
  world.load({ ...world.dump(), layout: { objects: old, rugs: structuredClone(base.rugs) } });
  for (const activity of ['water', 'stretch', 'pomodoro']) {
    const object = map.objects.find(o => o.use?.kind === 'wellness' && o.use.activity === activity);
    assert.ok(object, `${activity} object is missing`);
    assert.equal(routes(object.use, 'wheel'), false);
    assert.equal(routes(object.use, 'use'), false);
  }
  assert.equal(layoutProblem(map), null);
});

test('the original decorative cooler remains removable and distinct from personal reminder fixtures', () => {
  const map = structuredClone(base);
  const decorative = map.objects.find(o => o.type === 'water_cooler')!;
  assert.ok(decorative);
  const edited = applyEdit(map, { op: 'remove', id: decorative.id }, () => 'unused');
  assert.notEqual(typeof edited, 'string', 'decorative cooler must remain editable');
  if (typeof edited !== 'string') {
    assert.ok(!edited.objects.some(o => o.id === decorative.id));
    assert.ok(edited.objects.some(o => o.use?.kind === 'wellness' && o.use.activity === 'water'));
  }
});
