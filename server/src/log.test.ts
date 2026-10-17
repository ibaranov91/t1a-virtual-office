import test from 'node:test';
import assert from 'node:assert/strict';
import { logLine } from './log';
test('log lines are one short key=value line', () => {
  assert.equal(logLine('connect', { user: 'u1', name: 'Kim Lee', skip: undefined, tab: '' }), 'ev=connect user=u1 name="Kim Lee" tab=""');
  assert.equal(logLine('x', { m: 'a\nb' }), 'ev=x m="a b"');
  assert.ok(logLine('x', { m: 'y'.repeat(500) }).length < 200);
});
