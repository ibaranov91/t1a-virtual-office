import test from 'node:test';
import assert from 'node:assert/strict';
import { versionLine } from './buildInfo';
const web = { version: '2.0.0-dev', sha: 'aaa1111', builtAt: '' };
test('the version line shows the page build only when it is stale', () => {
  assert.equal(versionLine({ version: '2.0.0-dev', sha: 'aaa1111', startedAt: 0 }, web), 'v2.0.0-dev · aaa1111');
  assert.equal(versionLine({ version: '2.0.0-dev', sha: 'bbb2222', startedAt: 0 }, web), 'v2.0.0-dev · bbb2222 · page aaa1111, reload');
  assert.equal(versionLine(null, web), 'v2.0.0-dev · aaa1111');
});
