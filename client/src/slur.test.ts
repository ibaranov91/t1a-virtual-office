import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slur, slurBy } from './slur';

const text = 'Hello there, is this seat taken? See https://example.com/path soon';

test('level 0 leaves the text alone', () => {
  assert.equal(slur(text, 0, 'm1'), text);
});

test('the same text, level and seed slur the same way for every viewer', () => {
  for (const level of [1, 2, 3]) assert.equal(slur(text, level, 'm1'), slur(text, level, 'm1'));
  assert.notEqual(slur(text, 3, 'm1'), text);
});

test('links stay intact and deeper levels slur more', () => {
  for (const seed of ['a', 'b', 'c']) assert.ok(slur(text, 3, seed).includes('https://example.com/path'));
  const changes = (level: number) => ['a', 'b', 'c', 'd', 'e', 'f'].reduce((n, seed) => n + slur(text, level, seed).length - text.length, 0);
  assert.ok(changes(3) > changes(1));
});

test('only a drunk sender is slurred, and only for messages from while they were drunk', () => {
  const now = 1_000_000, drunk = [{ kind: 'drunk', until: now + 60_000, data: { level: 3 } }];
  assert.equal(slurBy([], text, now, 'x', now), text);
  assert.equal(slurBy(drunk, text, now - 10 * 60_000, 'x', now), text);
  assert.equal(slurBy(drunk, text, now, 'x', now), slur(text, 3, 'x'));
  assert.equal(slurBy([{ kind: 'drunk', until: now - 1, data: { level: 3 } }], text, now - 1000, 'x', now), text);
});
