/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { CUP_TABLES } from '../../shared/protocol';
import { ITEM_H, TABLE_TOPS, itemTop } from './tableTops';
import mapJson from '../../shared/tilemap.json';
import atlas from '../public/assets/atlas.json';

// Checks cup placement against the generated art itself (client/public/assets/world.png), so a change to a table's
// sprite that moves its top shows up here instead of as a cup hanging off the edge.
const TS = 16;
const frames = (atlas as { frames: Record<string, { x: number; y: number; w: number; h: number }> }).frames;
const objects = (mapJson as unknown as { objects: { id: string; type: string; x: number; y: number; w: number; h: number }[] }).objects;

/** gen-assets.mjs writes 8-bit RGBA, filter 0 on every row: enough of a PNG reader for that. */
function readPng(path: string) {
  const buf = readFileSync(path);
  let p = 8, w = 0, h = 0; const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (w * 4 + 1)], 0, 'unfiltered rows only');
    raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  }
  return { at: (x: number, y: number) => { const i = (y * w + x) * 4; return { a: px[i + 3], lum: 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2] }; } };
}
const world = readPng(new URL('../public/assets/world.png', import.meta.url).pathname);
/** A pixel of a frame, in the frame's own coordinates. */
const pixel = (name: string, x: number, y: number) => { const f = frames[name]; return world.at(f.x + x, f.y + y); };

const ITEMS = [{ name: 'cup', dx: 5, w: 6 }, { name: 'plate', dx: 4, w: 8 }];

test('every furniture type a cup can go on has a known tabletop and a sprite', () => {
  for (const type of CUP_TABLES) {
    assert.ok(TABLE_TOPS[type], `${type}: add its tabletop rows to TABLE_TOPS`);
    assert.ok(frames[type], `${type}: no sprite in the atlas`);
    const [back, front] = TABLE_TOPS[type];
    assert.ok(front - back + 1 >= ITEM_H, `${type}: tabletop thinner than a cup`);
    assert.ok(front < frames[type].h, `${type}: tabletop below the sprite`);
  }
});

test('a cup or plate on any tile of any table stands on the tabletop, inside its back and front edges', () => {
  let checked = 0;
  for (const o of objects.filter(o => CUP_TABLES.includes(o.type))) {
    const fr = frames[o.type], [back, front] = TABLE_TOPS[o.type];
    const spriteTop = (o.y + o.h) * TS - fr.h, spriteLeft = o.x * TS + (o.w * TS - fr.w) / 2;
    for (let ty = o.y; ty < o.y + o.h; ty++) for (let tx = o.x; tx < o.x + o.w; tx++) for (const it of ITEMS) {
      const top = itemTop(o, ty, fr.h) - spriteTop, bottom = top + ITEM_H - 1, left = tx * TS + it.dx - spriteLeft;
      const where = `${it.name} on ${o.type} ${o.id} at ${tx},${ty}`;
      assert.ok(top >= back && bottom <= front, `${where}: rows ${top}-${bottom} outside the tabletop ${back}-${front}`);
      assert.ok(left >= 0 && left + it.w <= fr.w, `${where}: off the side of the sprite`);
      for (let x = left; x < left + it.w; x++) assert.ok(pixel(o.type, x, bottom).a > 0, `${where}: nothing under its foot at column ${x}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} spots checked`);
});

test('TABLE_TOPS matches the art: the front edge is where the lighter top meets the darker front panel', () => {
  const lum = (type: string, x0: number, x1: number, y0: number, y1: number) => {
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x < x1; x++) { const p = pixel(type, x, y); if (p.a) { sum += p.lum; n++; } }
    return n ? sum / n : NaN;
  };
  for (const type of CUP_TABLES) {
    const fr = frames[type], [back, front] = TABLE_TOPS[type];
    const top = lum(type, 0, fr.w, front, front), below = lum(type, 0, fr.w, front + 2, front + 2);
    assert.ok(top > below, `${type}: row ${front} (${top.toFixed(0)}) should be tabletop, lighter than the front at row ${front + 2} (${below.toFixed(0)})`);
    assert.ok(pixel(type, Math.floor(fr.w / 2), back).a > 0 , `${type}: nothing at the back edge row ${back}`);
  }
});

test('the counter by the coffee machine: a cup sits on the worktop, not on the cupboard doors below it', () => {
  const c = objects.find(o => o.type === 'counter')!, fr = frames.counter;
  const bottom = itemTop(c, c.y, fr.h) - ((c.y + c.h) * TS - fr.h) + ITEM_H - 1;
  assert.ok(bottom <= 9, `cup bottom on sprite row ${bottom}; the doors start at row 10`);
});
