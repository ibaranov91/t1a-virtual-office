import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

// The office's panels are siblings: two with the same key (both key={me.id}) make React leak a copy of one on every
// re-render, and the 1 s tick piled up dozens of character dialogs until the app froze.
test('office panels have distinct keys', () => {
  const office = app.slice(app.indexOf('function Office('), app.indexOf('\nfunction ', app.indexOf('function Office(') + 1));
  const keys = [...office.matchAll(/\bkey=\{(`[^`]*`|[^}]*)\}/g)].map(m => m[1]);
  assert.ok(keys.length > 5, 'found the office panels');
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
});
