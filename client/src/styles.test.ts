import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const sizes = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

test('chrome font sizes use the type scale or a documented display exception', () => {
  // Preserve offsets so comments cannot hide declarations or change line numbers.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
  const lines = css.split('\n'), errors: string[] = [];
  for (const match of source.matchAll(/\bfont-size\s*:\s*([^;}]+)/g)) {
    const line = source.slice(0, match.index).split('\n').length;
    const value = match[1].trim().replace(/\s*!important\s*$/, '');
    if (!/^var\(--fs-(xs|sm|md|lg|xl|2xl)\)$/.test(value) && !/\/\*\s*ui-exception:\s*\S.+?\*\//.test(lines[line - 1])) {
      errors.push(`line ${line}: font-size: ${value}`);
    }
  }
  assert.deepEqual(errors, [], `Use --fs-* tokens or a same-line ui-exception reason:\n${errors.join('\n')}`);
});

test(':root defines all six font-size tokens', () => {
  const root = css.match(/:root\s*\{([^}]+)\}/)?.[1] ?? '';
  const missing = sizes.filter(size => !new RegExp(`--fs-${size}\\s*:\\s*\\d+(?:\\.\\d+)?px\\s*;`).test(root));
  assert.deepEqual(missing, [], `Missing :root tokens (line 1): ${missing.map(size => `--fs-${size}`).join(', ')}`);
});
