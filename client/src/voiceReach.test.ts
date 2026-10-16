import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reachLabel, unreachablePeers } from './voiceReach';

const now = 100_000;

test('a peer still connecting is not flagged until the grace period has passed', () => {
  assert.deepEqual(unreachablePeers([{ id: 'kim', state: 'connecting', since: now - 3_000 }], now), []);
  assert.deepEqual(unreachablePeers([{ id: 'kim', state: 'new', since: now - 3_000 }], now), []);
  assert.deepEqual(unreachablePeers([{ id: 'kim', state: 'connecting', since: now - 9_000 }], now), ['kim']);
});

test('dropped, failed, closed or missing connections count at once', () => {
  const peers = [
    { id: 'ana', state: 'disconnected' as const, since: now },
    { id: 'bo', state: 'failed' as const, since: now },
    { id: 'cy', state: 'closed' as const, since: now },
    { id: 'di', state: undefined, since: now },
    { id: 'ed', state: 'connected' as const, since: now - 60_000 },
  ];
  assert.deepEqual(unreachablePeers(peers, now), ['ana', 'bo', 'cy', 'di']);
});

test('the label names first names, or is empty when everyone is reachable', () => {
  assert.equal(reachLabel([]), '');
  assert.equal(reachLabel(['Kim Lee']), "Can't reach Kim");
  assert.equal(reachLabel(['Kim Lee', 'Ana']), "Can't reach Kim, Ana");
});
