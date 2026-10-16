import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import type { TileMap } from '../../shared/map';
import type { ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

function call(t: TestContext, presenceA: 'online' | 'in_call' = 'online') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const [a, b] = ['A', 'B'].map((n, i) => {
    const u = w.addUser(n, false, { x: 33 + i, y: 29 }); u.presence = 'online';
    const msgs: ServerMsg[] = [];
    const { socket } = w.connect(u.id, m => msgs.push(m));
    return { u, msgs, socket };
  });
  a.u.presence = presenceA;
  w.knock(a.u, b.u);
  const k = [...(w as any).knocks.values()][0];
  t.mock.timers.tick(15_000);
  w.reply(b.u, k.id, 'accept');
  return { w, a, b };
}

for (const [who, before] of [['knocker', 'online'], ['knocked', 'online'], ['knocker', 'in_call'], ['knocked', 'online']] as const) {
  test(`when the ${who} leaves a knock call, the other one's headset goes too (was ${before})`, (t: TestContext) => {
    const { w, a, b } = call(t, before);
    assert.ok(a.u.callId && a.u.callId === b.u.callId, 'in a call');
    assert.equal(a.u.presence, 'in_call'); assert.equal(b.u.presence, 'in_call');
    const [leaver, stayer] = who === 'knocker' ? [a, b] : [b, a];
    w.leaveCall(leaver.u);
    assert.equal(stayer.u.callId, null);
    assert.equal(stayer.u.presence, 'online', 'headset removed');
    assert.equal(leaver.u.presence, 'online');
    assert.ok(stayer.msgs.some(m => m.t === 'presence' && m.userId === stayer.u.id && m.presence === 'online'), 'and told');
  });
}
