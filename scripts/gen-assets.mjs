// Procedural placeholder art pack: writes client/public/assets/{world.png,characters.png,accessories.png,atlas.json}.
// Swap these files for a real pack (Kenney etc.) without touching code — the client
// only knows frame names from atlas.json.
// Run: node scripts/gen-assets.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// ---------- tiny RGBA canvas ----------
const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
};
class Img {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8Array(w * h * 4); }
  px(x, y, c) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !c) return;
    const [r, g, b, a] = typeof c === 'string' ? hex(c) : c;
    const i = (y * this.w + x) * 4;
    this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = a;
  }
  get(x, y) { const i = (y * this.w + x) * 4; return this.d.slice(i, i + 4); }
  alpha(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.d[(y * this.w + x) * 4 + 3]; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  hline(x, y, w, c) { this.rect(x, y, w, 1, c); }
  vline(x, y, h, c) { this.rect(x, y, 1, h, c); }
  ellipse(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px(x, y, c);
      }
  }
  // soft dark outline around every opaque shape
  outline(c = OUT) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.alpha(x, y)) continue;
      if (this.alpha(x - 1, y) || this.alpha(x + 1, y) || this.alpha(x, y - 1) || this.alpha(x, y + 1)) add.push([x, y]);
    }
    for (const [x, y] of add) this.px(x, y, c);
    return this;
  }
  mirror() {
    const o = new Img(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) o.px(this.w - 1 - x, y, this.get(x, y).some(v => v) ? [...this.get(x, y)] : null);
    return o;
  }
  blit(src, dx, dy) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      const p = src.get(x, y); if (p[3]) this.px(dx + x, dy + y, [...p]);
    }
  }
}

// ---------- PNG encoder ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const png = (img) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (img.w * 4 + 1)] = 0;
    Buffer.from(img.d.buffer, y * img.w * 4, img.w * 4).copy(raw, y * (img.w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

// ---------- palette ----------
const OUT = '#3a2329';
const rnd = (() => { let s = 1234567; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
const frames = {}; // name -> Img

// ---------- floor tiles ----------
const woodTile = (v, base, light, line, grain) => {
  const t = new Img(16, 16);
  t.rect(0, 0, 16, 16, base);
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    t.hline(0, y, 16, light);
    t.hline(0, y + 3, 16, line);
    const seam = (row * 5 + v * 7 + 3) % 16;
    t.vline(seam, y, 3, line);
    for (let k = 0; k < 2; k++) t.px((seam + 3 + k * 5 + v * 3) % 16, y + 1 + (k % 2), grain);
  }
  return t;
};
for (let v = 0; v < 3; v++) {
  frames[`wood_${v}`] = woodTile(v, '#c8874a', '#d79858', '#9c5f30', '#b5763e');
  frames[`wood_dark_${v}`] = woodTile(v, '#9a6440', '#a8714a', '#6e4228', '#8a5636');
}
frames.door_floor = woodTile(1, '#b47a46', '#c48a52', '#875228', '#a06a3a');
{
  const t = new Img(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.px(x, y, ((x >> 3) + (y >> 3)) % 2 ? '#d9c6a2' : '#efe2c6');
  t.hline(0, 0, 16, '#c9b48e'); t.vline(0, 0, 16, '#c9b48e'); t.hline(0, 8, 16, '#c9b48e'); t.vline(8, 0, 16, '#c9b48e');
  t.px(3, 3, '#fff6e0'); t.px(11, 11, '#e6d4b0');
  frames.tile_check = t;
}

// ---------- walls ----------
{
  const cap = new Img(16, 16);
  cap.rect(0, 0, 16, 16, '#4b3029');
  for (let i = 0; i < 6; i++) cap.px((i * 7 + 3) % 16, (i * 5 + 2) % 16, '#553730');
  frames.wall_cap = cap;

  const paper = (t, y0, h) => {
    t.rect(0, y0, 16, h, '#e8cfa4');
    for (let x = 1; x < 16; x += 4) t.vline(x, y0, h, '#dcbd8e');
    for (let y = y0 + 2; y < y0 + h; y += 5) t.px(3, y, '#c9a476'), t.px(11, y + 2, '#c9a476');
  };
  const top = new Img(16, 16);
  paper(top, 0, 16);
  top.rect(0, 0, 16, 2, '#7a4b34'); top.hline(0, 2, 16, '#c99f6e');
  frames.wall_face_top = top;

  const wains = (t, y0) => { // wainscot to bottom of tile
    t.hline(0, y0, 16, '#6e4230');
    t.hline(0, y0 + 1, 16, '#c08050');
    t.rect(0, y0 + 2, 16, 16 - y0 - 3, '#a0643d');
    for (let x = 3; x < 16; x += 8) t.vline(x, y0 + 3, 16 - y0 - 5, '#80492b');
    t.hline(0, 15, 16, '#6a3c26');
  };
  const bottom = new Img(16, 16);
  paper(bottom, 0, 16); wains(bottom, 7);
  frames.wall_face_bottom = bottom;

  const short = new Img(16, 16);
  paper(short, 0, 16); short.rect(0, 0, 16, 2, '#7a4b34'); short.hline(0, 2, 16, '#c99f6e'); wains(short, 9);
  frames.wall_face_short = short;
}

// ---------- rugs (9-slice) ----------
const RUGS = {
  green: ['#7a9a55', '#55703a', '#9ab86d'],
  blue: ['#5577a8', '#3b5582', '#86a6d2'],
  orange: ['#d08a4a', '#a4622e', '#eab070'],
  red: ['#b4534a', '#843a35', '#d47a6e'],
  teal: ['#4f9a92', '#36706b', '#7cc2b8'],
};
for (const [color, [main, dark, acc]] of Object.entries(RUGS)) {
  for (const part of ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se']) {
    const t = new Img(16, 16);
    t.rect(0, 0, 16, 16, main);
    // diamond motif
    for (let i = 0; i < 4; i++) { t.px(8 + i, 4 + i, acc); t.px(8 - i, 4 + i, acc); t.px(8 + i, 12 - i, acc); t.px(8 - i, 12 - i, acc); }
    t.px(8, 8, dark);
    const n = part.includes('n'), s = part.includes('s'), w = part.includes('w'), e = part.includes('e');
    if (n) { t.hline(0, 0, 16, OUT); t.rect(0, 1, 16, 2, dark); t.hline(0, 4, 16, acc); }
    if (s) { t.hline(0, 15, 16, OUT); t.rect(0, 13, 16, 2, dark); t.hline(0, 11, 16, acc); }
    if (w) { t.vline(0, 0, 16, OUT); t.rect(1, 0, 2, 16, dark); t.vline(4, 0, 16, acc); }
    if (e) { t.vline(15, 0, 16, OUT); t.rect(13, 0, 2, 16, dark); t.vline(11, 0, 16, acc); }
    if (n) t.hline(w ? 1 : 0, 0, 16, OUT);
    if (s) for (let x = 1; x < 16; x += 2) t.px(x, 15, '#eadcb8');
    if (n) for (let x = 1; x < 16; x += 2) t.px(x, 0, '#eadcb8');
    frames[`rug_${color}_${part}`] = t;
  }
}

// ---------- furniture ----------
const W1 = '#c8874a', W1L = '#dba066', W1D = '#9c5f30', W1DD = '#7d4a26';
{
  const t = new Img(32, 24); // desk with monitor
  t.rect(1, 6, 30, 9, W1); t.hline(1, 6, 30, W1L);
  t.rect(1, 15, 30, 7, W1D); t.hline(1, 21, 30, W1DD); t.rect(21, 17, 4, 1, '#e0b070');
  t.vline(10, 15, 7, W1DD);
  t.rect(9, 1, 14, 8, '#3b3b48'); t.rect(10, 2, 12, 6, '#6fa8c8'); t.hline(10, 2, 12, '#9fd0e8'); t.px(11, 3, '#cfeaf6');
  t.rect(15, 9, 2, 2, '#5a5a66');
  t.rect(11, 11, 10, 2, '#e8e0d0'); t.hline(11, 12, 10, '#c8c0b0');
  t.rect(25, 9, 3, 3, '#f4f0e6'); t.px(28, 10, '#f4f0e6'); t.hline(25, 9, 3, '#6b4229');
  t.rect(3, 9, 4, 3, '#f8f4ec'); t.hline(3, 10, 3, '#b0a898');
  frames.desk = t.outline();
}
{
  const t = new Img(16, 16); // chair (top-down-ish)
  t.rect(3, 1, 10, 4, W1D); t.hline(3, 1, 10, W1);
  t.rect(3, 5, 10, 7, '#b4534a'); t.hline(4, 5, 8, '#d0756a'); t.hline(3, 11, 10, '#843a35');
  t.vline(3, 12, 2, W1DD); t.vline(12, 12, 2, W1DD);
  frames.chair = t.outline();
  frames.chair_down = frames.chair; // sitter faces down: backrest behind them
}
{
  // sitter faces up (toward a desk): seat here, backrest drawn OVER the sitter as a separate frame
  const seat = new Img(16, 16);
  seat.rect(3, 3, 10, 7, '#b4534a'); seat.hline(4, 3, 8, '#d0756a'); seat.hline(3, 9, 10, '#843a35');
  seat.vline(3, 10, 4, W1DD); seat.vline(12, 10, 4, W1DD);
  frames.chair_up = seat.outline();
  const back = new Img(16, 16);
  back.rect(3, 9, 10, 4, W1D); back.hline(3, 9, 10, W1); back.hline(3, 12, 10, W1DD);
  back.vline(3, 13, 2, W1DD); back.vline(12, 13, 2, W1DD);
  frames.chair_up_back = back.outline();
  // sitter faces right: backrest on the left
  const r = new Img(16, 16);
  r.rect(2, 1, 3, 12, W1D); r.vline(2, 1, 12, W1);
  r.rect(5, 5, 8, 7, '#b4534a'); r.hline(5, 5, 8, '#d0756a'); r.hline(5, 11, 8, '#843a35');
  r.vline(2, 13, 1, W1DD); r.vline(12, 12, 2, W1DD);
  frames.chair_right = r.outline();
  frames.chair_left = r.mirror();
}
{
  const t = new Img(16, 16); // stool
  t.ellipse(8, 7, 5, 4, '#a4622e'); t.ellipse(8, 6.5, 4, 3, '#c47a3e'); t.px(6, 5, '#e09a5a');
  t.vline(5, 10, 4, W1DD); t.vline(10, 10, 4, W1DD);
  frames.stool = t.outline();
}
{
  const t = new Img(16, 32); // floor lamp
  for (let y = 2; y <= 10; y++) { const w = 4 + Math.floor((y - 2) / 2); t.hline(8 - w, y, w * 2, y < 4 ? '#f8e0a0' : '#f2d28a'); }
  t.hline(4, 10, 8, '#d9b060');
  t.rect(7, 11, 2, 17, '#5a4a40'); t.vline(7, 11, 17, '#6e5c50');
  t.rect(4, 27, 8, 3, '#5a4a40'); t.hline(4, 27, 8, '#6e5c50');
  frames.lamp = t.outline();
}
{
  const t = new Img(16, 32); // the same lamp, switched off: a cool, dim shade
  for (let y = 2; y <= 10; y++) { const w = 4 + Math.floor((y - 2) / 2); t.hline(8 - w, y, w * 2, y < 4 ? '#bfb6a6' : '#a89e8e'); }
  t.hline(4, 10, 8, '#8a8070');
  t.rect(7, 11, 2, 17, '#5a4a40'); t.vline(7, 11, 17, '#6e5c50');
  t.rect(4, 27, 8, 3, '#5a4a40'); t.hline(4, 27, 8, '#6e5c50');
  frames.lamp_off = t.outline();
}
{
  const t = new Img(32, 32); // bookshelf
  t.rect(1, 1, 30, 30, '#8a5232'); t.rect(3, 3, 26, 26, '#4e2c1a');
  const BOOKS = ['#b4534a', '#5577a8', '#7a9a55', '#d0a040', '#8a5aa0', '#e8dcc8', '#4f9a92'];
  for (const sy of [3, 12, 21]) {
    let x = 3;
    while (x < 28) {
      const w = 2 + Math.floor(rnd() * 2), h = 5 + Math.floor(rnd() * 3);
      if (x + w > 29) break;
      t.rect(x, sy + 8 - h, w, h, BOOKS[Math.floor(rnd() * BOOKS.length)]);
      t.vline(x, sy + 8 - h, h, OUT);
      x += w + (rnd() < 0.2 ? 2 : 0);
    }
    t.hline(1, sy + 8, 30, '#a8683e');
  }
  t.hline(1, 1, 30, '#a8683e');
  frames.bookshelf = t.outline();
}
{
  const t = new Img(16, 32); // potted plant
  const leaves = [[8, 9, 5, 5, '#4a7e3a'], [5, 14, 4, 4, '#4a7e3a'], [11, 14, 4, 4, '#4a7e3a'], [8, 6, 3, 4, '#5f9a48'], [5, 11, 3, 3, '#5f9a48'], [11, 11, 3, 3, '#5f9a48'], [8, 15, 4, 4, '#5f9a48']];
  for (const [x, y, rx, ry, c] of leaves) t.ellipse(x, y, rx, ry, c);
  for (const [x, y] of [[7, 5], [5, 10], [10, 9], [8, 13], [12, 13], [4, 15]]) t.px(x, y, '#8cc864');
  t.rect(4, 21, 8, 9, '#c0643c'); t.hline(3, 20, 10, '#d8805a'); t.hline(3, 21, 10, '#d8805a'); t.hline(4, 29, 8, '#9a4a2a');
  t.vline(5, 22, 7, '#d8805a');
  frames.plant = t.outline();
}
{
  const t = new Img(96, 40); // long meeting table (6x2)
  t.rect(1, 9, 94, 23, '#b97a45'); t.hline(1, 9, 94, '#d49a5e');
  for (let y = 15; y < 32; y += 6) t.hline(2, y, 92, '#a86c3a');
  t.rect(1, 32, 94, 6, '#8a5232'); t.hline(1, 37, 94, '#6a3c22');
  for (const x of [6, 88]) t.rect(x, 32, 3, 6, '#6a3c22');
  // stuff on the table
  t.rect(10, 13, 10, 7, '#f4f0e6'); t.hline(11, 15, 7, '#b0a898'); t.hline(11, 17, 5, '#b0a898');
  t.rect(40, 16, 14, 9, '#5a5a66'); t.rect(41, 17, 12, 6, '#8fc0dc');
  t.rect(70, 12, 3, 3, '#f4f0e6'); t.rect(78, 22, 3, 3, '#e8b860');
  t.rect(26, 22, 3, 3, '#f4f0e6');
  frames.table_long = t.outline();
}
{
  const t = new Img(16, 24); // small round table
  t.ellipse(8, 10, 7, 5, '#a86c3a'); t.ellipse(8, 9, 7, 5, '#c8874a'); t.ellipse(7, 8, 4, 2, '#d79858');
  t.rect(7, 14, 2, 7, W1DD); t.hline(5, 21, 6, W1DD);
  t.rect(9, 6, 3, 3, '#f4f0e6'); t.hline(9, 6, 3, '#6b4229');
  frames.table_round = t.outline();
}
{
  const t = new Img(32, 40); // 4-seat co-working table (2x2)
  t.rect(1, 9, 30, 22, '#d4a066'); t.hline(1, 9, 30, '#e6b47a');
  t.rect(1, 31, 30, 6, '#9c6a3c'); t.hline(1, 36, 30, '#7a4e2a');
  t.rect(3, 12, 9, 6, '#4a4a58'); t.rect(4, 13, 7, 4, '#8fc0dc'); // laptops
  t.rect(20, 22, 9, 6, '#4a4a58'); t.rect(21, 23, 7, 4, '#a8d898');
  t.rect(21, 12, 6, 5, '#f4f0e6'); t.hline(22, 14, 4, '#b0a898');
  t.rect(6, 23, 3, 3, '#f4f0e6'); t.hline(6, 23, 3, '#6b4229');
  t.rect(14, 18, 4, 3, '#c0643c'); t.ellipse(16, 16.5, 3, 2.5, '#5f9a48');
  frames.table_big = t.outline();
}
const counterSeg = (t, y0) => {
  t.rect(0, y0 + 1, 16, 8, '#e8dcc8'); t.hline(0, y0 + 1, 16, '#f6eee0'); t.hline(0, y0 + 8, 16, '#cbbba0');
  t.rect(0, y0 + 9, 16, 12, '#9c5f30'); t.hline(0, y0 + 20, 16, '#6e4228');
  t.rect(2, y0 + 11, 12, 8, '#a8693a'); t.px(11, y0 + 15, '#e0b070'); t.px(12, y0 + 15, '#e0b070');
  t.hline(0, y0, 16, OUT); t.hline(0, y0 + 21, 16, OUT);
};
{ const t = new Img(16, 24); counterSeg(t, 1); frames.counter = t; }
{
  const t = new Img(16, 32); // espresso machine on a counter segment
  counterSeg(t, 9);
  const m = new Img(16, 32);
  m.rect(3, 1, 10, 12, '#c24a3c'); m.vline(3, 1, 12, '#d86a5a'); m.rect(3, 9, 10, 4, '#8a2f28');
  m.rect(5, 3, 6, 3, '#d8dce0'); m.px(6, 4, '#4a4a58'); m.px(9, 4, '#7cc87c');
  m.rect(7, 7, 2, 2, '#5a5a66'); m.rect(6, 10, 3, 3, '#f4f0e6');
  m.outline();
  t.blit(m, 0, 0);
  frames.coffee_machine = t;
}
{
  const t = new Img(16, 32); // fridge
  t.rect(1, 1, 14, 29, '#e8eef0'); t.vline(1, 1, 29, '#ffffff'); t.vline(14, 1, 29, '#c4ccd4');
  t.hline(1, 11, 14, '#a8b0b8'); t.rect(11, 4, 1, 5, '#8a929a'); t.rect(11, 14, 1, 7, '#8a929a');
  t.rect(4, 4, 3, 3, '#f0c040'); t.rect(4, 15, 4, 3, '#e87a6a'); t.hline(1, 29, 14, '#a8b0b8');
  frames.fridge = t.outline();
}
{
  const t = new Img(32, 16); // the vault door, set in the wall: a riveted steel frame, a round cog-shaped door, a yellow 13
  t.rect(0, 0, 32, 16, '#3c4048'); t.rect(1, 1, 30, 14, '#50555f'); t.hline(1, 1, 30, '#6a7079'); t.vline(1, 1, 14, '#6a7079');
  for (const [x, y] of [[2, 2], [29, 2], [2, 13], [29, 13], [2, 7], [29, 7]]) t.px(x, y, '#8a909c'); // rivets
  t.rect(5, 6, 4, 4, '#767c88'); t.px(6, 7, '#9aa0ac'); t.px(7, 8, '#9aa0ac'); // the hinge arm
  for (const [x, y] of [[16, 0], [16, 15], [9, 8], [23, 8], [11, 3], [21, 3], [11, 13], [21, 13]]) t.rect(x - 1, y, 2, 1, '#6e7482'); // cog teeth
  t.ellipse(16, 8, 7, 7, '#6e7482'); t.ellipse(16, 8, 6, 6, '#8a909c'); t.ellipse(16, 8, 5, 5, '#5a5f6a'); // the door and its rim
  t.vline(14, 6, 5, '#f0c040'); t.px(13, 7, '#f0c040'); t.hline(13, 10, 3, '#f0c040'); // 1
  t.hline(17, 6, 3, '#f0c040'); t.px(19, 7, '#f0c040'); t.hline(18, 8, 2, '#f0c040'); t.px(19, 9, '#f0c040'); t.hline(17, 10, 3, '#f0c040'); // 3
  frames.safe = t.outline();
}
{
  const t = new Img(48, 24); // sofa
  const C = '#6f9a8a', CL = '#8ab8a6', CD = '#4e7466';
  t.rect(4, 2, 40, 10, CD); t.hline(4, 2, 40, C);
  t.rect(5, 3, 18, 8, C); t.rect(25, 3, 18, 8, C); t.hline(6, 3, 16, CL); t.hline(26, 3, 16, CL);
  t.rect(5, 12, 38, 6, C); t.vline(24, 12, 6, CD); t.hline(5, 12, 38, CL);
  t.rect(1, 6, 5, 15, CD); t.rect(42, 6, 5, 15, CD); t.hline(1, 6, 5, C); t.hline(42, 6, 5, C);
  t.rect(5, 18, 38, 3, CD); t.vline(3, 21, 2, '#5a3a2a'); t.vline(44, 21, 2, '#5a3a2a');
  t.rect(8, 6, 5, 5, '#e8b860'); t.rect(35, 6, 5, 5, '#d47a6e');
  frames.sofa = t.outline();
}
{
  const t = new Img(48, 24); // reception desk
  t.rect(1, 5, 46, 7, '#e8dcc8'); t.hline(1, 5, 46, '#f6eee0');
  t.rect(1, 12, 46, 10, '#8a5232'); t.hline(1, 21, 46, '#6a3c22');
  t.rect(16, 14, 16, 5, '#c8a050'); t.hline(16, 14, 16, '#e0c070');
  // "T1A" in tiny pixels
  const T1A = ['111.1.111', '.1.11.1.1', '.1..1.111', '.1..1.1.1'];
  T1A.forEach((row, j) => [...row].forEach((ch, i) => ch === '1' && t.px(19 + i, 15 + j, '#6a3c22')));
  t.ellipse(8, 7, 2, 1.5, '#d8a040'); t.px(8, 5, '#d8a040');
  t.rect(36, 1, 6, 6, '#5f9a48'); t.rect(37, 6, 4, 3, '#c0643c');
  frames.reception = t.outline();
}

{
  const t = new Img(32, 32); // classic arched jukebox
  t.ellipse(16, 13, 13, 11, '#8a5232'); t.rect(3, 13, 26, 17, '#8a5232');
  t.ellipse(16, 13, 11, 9, '#f2b45a'); t.rect(5, 13, 22, 15, '#f2b45a');
  t.ellipse(16, 13, 8, 7, '#d47a6e'); t.rect(8, 13, 16, 14, '#d47a6e');
  t.ellipse(16, 13, 6, 5, '#4a4a58'); t.rect(10, 13, 12, 13, '#4a4a58');
  t.rect(10, 11, 12, 6, '#9cc8e0'); t.ellipse(16, 14, 4, 3, '#3d3a52');
  t.ellipse(16, 14, 1, 1, '#e8b860'); t.hline(11, 11, 10, '#e8eef0');
  t.rect(10, 19, 12, 7, '#3a2329');
  for (let y = 20; y < 26; y += 2) t.hline(11, y, 10, '#8a929a');
  t.vline(14, 19, 7, '#4a4a58'); t.vline(18, 19, 7, '#4a4a58');
  for (const [x, y, c] of [[6, 13, '#7cc87c'], [8, 7, '#9cc8e0'], [15, 4, '#e8dcc8'], [22, 7, '#7cc87c'], [25, 13, '#9cc8e0']]) t.rect(x, y, 2, 2, c);
  t.rect(4, 28, 24, 2, '#6a3c22'); t.hline(5, 28, 22, '#a8683e');
  t.rect(4, 30, 4, 1, '#4e2c1a'); t.rect(24, 30, 4, 1, '#4e2c1a');
  frames.jukebox = t.outline();
}
{
  const t = new Img(32, 16);
  // An X stand under a compact stage keyboard.
  for (let y = 8; y < 15; y++) { t.rect(9 + y - 8, y, 2, 1, '#8a929a'); t.rect(21 - (y - 8), y, 2, 1, '#8a929a'); }
  t.rect(2, 2, 28, 6, '#3d3a52'); t.hline(3, 2, 26, '#8a929a');
  t.rect(4, 4, 23, 4, '#efe2c6');
  for (let x = 6; x < 27; x += 3) t.vline(x, 5, 3, '#9c5f30');
  for (const x of [5, 8, 14, 17, 20, 26]) t.rect(x, 4, 2, 2, '#3a2329');
  t.px(28, 4, '#7cc87c'); frames.keyboard = t.outline();
}
{
  const t = new Img(32, 32);
  for (const x of [4, 27]) { t.vline(x, 7, 17, '#8a929a'); t.hline(x - 2, 24, 5, '#8a929a'); t.ellipse(x, 7, 4, 2, '#d8a040'); t.hline(x - 2, 6, 4, '#e8b860'); }
  for (const [x, y, r] of [[10, 12, 4], [20, 12, 4], [7, 20, 4]]) {
    t.rect(x - r, y, r * 2, 5, '#b4534a'); t.ellipse(x, y, r, 2.5, '#efe2c6'); t.hline(x - r + 1, y + 5, r * 2 - 2, '#8a929a');
  }
  t.ellipse(16, 23, 8, 8, '#b4534a'); t.ellipse(16, 23, 6.5, 6.5, '#efe2c6');
  t.ellipse(16, 23, 5, 5, '#3d3a52');
  t.hline(13, 21, 6, '#e8b860'); t.vline(16, 21, 5, '#e8b860');
  t.rect(9, 29, 2, 2, '#8a929a'); t.rect(22, 29, 2, 2, '#8a929a');
  frames.drum_kit = t.outline();
}
{
  const t = new Img(16, 24);
  t.rect(2, 9, 11, 13, '#3d3a52'); t.rect(3, 10, 9, 2, '#8a929a');
  t.rect(3, 13, 9, 8, '#3a2329');
  for (let y = 14; y < 21; y += 2) t.hline(4, y, 7, '#8a929a');
  t.rect(5, 7, 5, 2, '#3d3a52'); t.px(4, 11, '#e8b860'); t.px(7, 11, '#7cc87c');
  // Four-string bass leaning against the combo.
  t.ellipse(11, 18, 3, 4, '#c8874a'); t.ellipse(10, 15, 2, 2, '#c8874a');
  for (let y = 2; y < 18; y++) { const x = 13 - Math.floor(y / 7); t.rect(x, y, 2, 1, '#d8a050'); t.px(x, y, '#efe2c6'); }
  t.rect(12, 1, 3, 3, '#c8874a'); t.rect(10, 19, 3, 1, '#3a2329');
  frames.bass_amp = t.outline();
}
for (const n of [1, 2]) {
  const t = new Img(8, 9), c = '#f2b45a';
  t.vline(4, 1, 5, c); t.ellipse(3, 6, 2, 1.5, c);
  if (n === 1) t.hline(4, 1, 3, c);
  else { t.hline(4, 1, 3, c); t.vline(6, 1, 4, c); t.px(5, 5, c); }
  frames[`note_${n}`] = t.outline();
}

// ---------- wall decor ----------
{
  const t = new Img(32, 32); // window
  t.rect(3, 3, 26, 22, '#f0e6d2');
  t.rect(5, 5, 10, 8, '#9cc8e0'); t.rect(17, 5, 10, 8, '#9cc8e0'); t.rect(5, 15, 10, 8, '#86b8d4'); t.rect(17, 15, 10, 8, '#86b8d4');
  t.px(6, 6, '#e8f6ff'); t.px(7, 6, '#e8f6ff'); t.px(6, 7, '#e8f6ff'); t.px(18, 6, '#e8f6ff');
  t.rect(2, 25, 28, 3, '#d8c8a8'); t.hline(2, 25, 28, '#f6eee0');
  t.ellipse(8, 24, 3, 2, '#5f9a48'); t.ellipse(24, 24, 3, 2, '#d47a6e');
  frames.window = t.outline();
}
{
  const t = new Img(48, 32); // whiteboard
  t.rect(3, 3, 42, 22, '#c8ccd0'); t.rect(5, 5, 38, 18, '#f8f8f4');
  for (let x = 8; x < 22; x++) t.px(x, 10 + Math.round(Math.sin(x / 2) * 2), '#5577a8');
  t.hline(26, 8, 10, '#b4534a'); t.hline(26, 13, 10, '#b4534a'); t.vline(26, 8, 6, '#b4534a'); t.vline(35, 8, 6, '#b4534a');
  t.hline(8, 17, 12, '#7a9a55'); t.hline(8, 19, 8, '#7a9a55'); t.hline(28, 17, 10, '#3a2329');
  t.rect(14, 25, 20, 2, '#a8b0b8'); t.px(18, 24, '#b4534a'); t.px(22, 24, '#5577a8');
  frames.whiteboard = t.outline();
}
{
  const t = new Img(16, 32); // tall painting
  t.rect(2, 4, 12, 18, '#c8a050'); t.rect(4, 6, 8, 14, '#86b8d4');
  t.rect(4, 14, 8, 6, '#7a9a55'); t.ellipse(9, 9, 1.5, 1.5, '#f8e0a0');
  frames.painting = t.outline();
}
{
  const t = new Img(16, 16);
  t.rect(3, 3, 10, 9, '#c8a050'); t.rect(4, 4, 8, 7, '#d47a6e'); t.rect(4, 8, 8, 3, '#e8b860');
  frames.painting_small = t.outline();
}
{
  const t = new Img(32, 16); // notice board
  t.rect(2, 2, 28, 12, '#a86c3a'); t.rect(3, 3, 26, 10, '#d8a868');
  const notes = [[5, 4, '#f8f4ec'], [12, 5, '#f8e070'], [19, 4, '#a8d8f0'], [24, 6, '#f8b8c8']];
  for (const [x, y, c] of notes) { t.rect(x, y, 5, 5, c); t.px(x + 2, y, '#b4534a'); }
  frames.noticeboard = t.outline();
}
{
  const t = new Img(16, 16); // clock
  t.ellipse(8, 7, 5, 5, '#f8f4ec'); t.vline(8, 4, 4, OUT); t.hline(8, 7, 3, OUT);
  frames.clock = t.outline();
  // the world clocks: a coloured rim, no hands (the engine draws those from the real time)
  for (const [city, rim] of [['nyc', '#d8584a'], ['berlin', '#e8c040'], ['moscow', '#4a88d8']]) {
    const w = new Img(16, 16);
    w.ellipse(8, 7, 6, 6, rim); w.ellipse(8, 7, 5, 5, '#f8f4ec');
    for (const [x, y] of [[8, 3], [8, 11], [4, 7], [12, 7]]) w.px(x, y, '#a89a8c');
    frames[`clock_${city}`] = w.outline();
  }
}
{
  const t = new Img(16, 16); // wall calendar: red header with rings, a month of days, today marked
  t.rect(3, 3, 10, 11, '#f8f4ec'); t.rect(3, 3, 10, 3, '#b4534a'); t.hline(3, 5, 10, '#94403a');
  t.px(5, 2, '#8c8a98'); t.px(10, 2, '#8c8a98');
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) t.px(4 + c * 2 + (r % 2 ? 1 : 0), 7 + r * 2, '#8c8a98');
  t.rect(9, 9, 2, 2, '#5577a8');
  frames.calendar = t.outline();
}
{
  const t = new Img(16, 16); // meetings board: a slate sign with names chalked on, a lit "in use" dot
  t.rect(2, 3, 12, 10, '#a86c3a'); t.rect(3, 4, 10, 8, '#3a4048');
  t.hline(4, 6, 5, '#e8e0d0'); t.hline(4, 8, 7, '#c8c0b0'); t.hline(4, 10, 4, '#c8c0b0');
  t.px(11, 5, '#8c8a98'); t.px(11, 6, '#6e6c7a'); // a lamp the client lights with a badge when meetings are on
  frames.meetings_board = t.outline();
}
{
  const t = new Img(32, 32); // wall screen: a dark bezel on a bracket, a blue idle picture; the client lights it when live
  t.rect(2, 4, 28, 18, '#2a2630'); t.rect(4, 6, 24, 14, '#24406a');
  t.rect(4, 6, 24, 3, '#2e5488'); t.hline(6, 12, 9, '#4a78b0'); t.hline(6, 15, 14, '#3a6498'); t.hline(6, 17, 6, '#3a6498');
  t.px(26, 20, '#7cc87c'); t.rect(14, 22, 4, 3, '#4a4652'); t.rect(10, 25, 12, 1, '#4a4652');
  frames.screen = t.outline();
}
{
  const t = new Img(16, 16); // exit door (sits on the short wall face) with a green EXIT sign
  t.rect(2, 0, 12, 16, '#6a3c22');
  t.rect(3, 4, 10, 12, '#9c5f30'); t.vline(3, 4, 12, '#b97a45'); t.vline(8, 5, 11, '#7d4a26');
  t.rect(4, 6, 3, 4, '#a8693a'); t.rect(9, 6, 3, 4, '#a8693a'); t.px(11, 11, '#f0c040');
  t.rect(4, 0, 8, 3, '#3f9a5a'); t.hline(5, 1, 6, '#c8f0c8');
  frames.exit_door = t;
}
{
  const t = new Img(16, 16); // doormat in front of the exit
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.px(x, y, (x * 73856093 ^ y * 19349663) % 3 ? '#a0603a' : '#8a4e2c');
  t.rect(2, 4, 12, 9, '#6e8a4a'); t.rect(3, 5, 10, 7, '#7e9c56');
  for (let x = 4; x < 12; x += 2) t.vline(x, 6, 5, '#6e8a4a');
  frames.doormat = t;
}
{
  const t = new Img(10, 10); // work bag, carried on the way out
  t.hline(3, 1, 4, '#5a3a2a'); t.px(2, 2, '#5a3a2a'); t.px(7, 2, '#5a3a2a');
  t.rect(1, 3, 8, 6, '#8a5232'); t.hline(1, 3, 8, '#a8683e'); t.hline(1, 5, 8, '#6a3c22'); t.px(5, 5, '#f0c040');
  frames.bag = t.outline();
}

// ---------- emote bubbles ----------
const bubble = (draw) => {
  const t = new Img(14, 14);
  t.rect(2, 1, 10, 9, '#fff8e8'); t.rect(1, 2, 12, 7, '#fff8e8');
  t.rect(5, 10, 3, 1, '#fff8e8'); t.px(6, 11, '#fff8e8');
  draw(t);
  return t.outline();
};
frames.bubble_zzz = bubble((t) => {
  const Z = (x, y, s, c) => { t.hline(x, y, s, c); for (let i = 1; i < s - 1; i++) t.px(x + s - 1 - i, y + i, c); t.hline(x, y + s - 1, s, c); };
  Z(3, 4, 4, '#5b7fc4'); Z(8, 2, 3, '#86a6d2');
});
frames.bubble_headset = bubble((t) => {
  t.hline(4, 2, 6, '#4a4a5a'); t.px(3, 3, '#4a4a5a'); t.px(10, 3, '#4a4a5a');
  t.rect(2, 4, 2, 4, '#4f9a92'); t.rect(10, 4, 2, 4, '#4f9a92');
  t.hline(4, 8, 3, '#4a4a5a'); t.px(4, 7, '#4a4a5a');
});
frames.bubble_hand = bubble((t) => {
  const c = '#d0a040';
  t.rect(5, 4, 5, 5, c); t.vline(5, 2, 4, c); t.vline(7, 1, 5, c); t.vline(9, 2, 4, c);
  t.rect(3, 5, 2, 2, c); t.px(4, 7, c); t.px(6, 8, '#f2c79b');
});
frames.bubble_deaf = bubble((t) => {
  t.hline(4, 2, 6, '#4a4a5a'); t.px(3, 3, '#4a4a5a'); t.px(10, 3, '#4a4a5a');
  t.rect(2, 4, 2, 4, '#4f9a92'); t.rect(10, 4, 2, 4, '#4f9a92');
  for (let i = 0; i < 8; i++) t.px(3 + i, 1 + i, '#d8463c');
});
frames.bubble_bang = bubble((t) => { t.rect(6, 2, 2, 4, '#d8463c'); t.rect(6, 7, 2, 2, '#d8463c'); });
frames.bubble_dots = bubble((t) => { for (const x of [3, 6, 9]) t.rect(x, 5, 2, 2, '#7a5a50'); });
{
  const t = new Img(14, 14); // thought cloud: "should I go?"
  t.ellipse(7, 5, 6, 4.5, '#fff8e8'); t.ellipse(4, 6, 3.5, 3, '#fff8e8'); t.ellipse(10, 6, 3.5, 3, '#fff8e8');
  t.rect(3, 11, 2, 2, '#fff8e8'); t.px(1, 13, '#fff8e8');
  for (const x of [3, 6, 9]) t.rect(x, 5, 2, 2, '#9a7a70');
  frames.bubble_think = t.outline();
}
frames.bubble_meeting = bubble((t) => {
  t.rect(3, 3, 8, 5, '#5577a8'); t.rect(4, 4, 6, 3, '#9cc8e0'); t.hline(5, 8, 4, '#4a4a5a');
});
// muted mic in a call
frames.bubble_muted = bubble((t) => {
  t.rect(6, 2, 2, 4, '#7a6a64'); t.px(5, 5, '#7a6a64'); t.px(8, 5, '#7a6a64'); t.hline(5, 6, 4, '#7a6a64'); t.px(6, 7, '#7a6a64'); t.hline(5, 8, 4, '#7a6a64');
  for (let i = 0; i < 7; i++) t.px(3 + i, 2 + i, '#d8463c');
});
// talking: sound bars; _1/_2 alternate while speaking, _0 is the quiet listener
for (const [i, hs] of [[0, [1, 2, 1, 2]], [1, [2, 5, 3, 4]], [2, [4, 3, 5, 2]]]) {
  frames[`bubble_talk_${i}`] = bubble((t) => {
    const c = i === 0 ? '#9ab8b0' : '#3f8f84';
    hs.forEach((h, k) => t.rect(3 + k * 2 + (k > 1 ? 1 : 0), 8 - h, 1, h, c));
    if (i) t.px(2, 3, '#e8b860'); // a little spark when speaking
  });
}
{
  const t = new Img(10, 8); // destination marker
  t.hline(1, 1, 8, '#f8d850'); t.hline(2, 2, 6, '#f8d850'); t.hline(3, 3, 4, '#f8d850'); t.hline(4, 4, 2, '#f8d850');
  t.hline(2, 1, 3, '#fff4b0');
  frames.marker = t.outline();
}

// ---------- characters ----------
// Key colors are swapped per user on the client (see atlas.character.keys).
const K = {
  skin: '#f2c79b', skinShade: '#d9a073', hair: '#6b3e26', hairShade: '#4f2b1a',
  shirt: '#4a7ab0', shirtShade: '#355a87', pants: '#3d3a52', pantsShade: '#2c293d',
  eyes: '#2b1d1f', shoes: '#4a3028',
};
const SHOE = K.shoes, EYE = K.eyes, BLUSH = '#ec9a8a';
const STYLES = ['short', 'long', 'ponytail'];
const TOPS = ['T-shirt', 'Button-up shirt', 'Sweater'];
const BOTTOMS = ['Pants', 'Skirt', 'Shorts'];
const DIRS = ['down', 'left', 'right', 'up'];
const ACCESSORY_KEYS = { primary: '#ff00ff', highlight: '#00ffff' };
const ACCESSORY_ITEMS = ['round_glasses', 'rectangular_glasses', 'cap', 'bowler'];

function drawChar(style, dir, f, top = 0, bottom = 0) {
  const t = new Img(16, 24);
  const sit = f === 5; // seated: body drops 2px, legs fold forward
  const bob = sit ? 2 : 0;
  const stepA = f === 1, stepB = f === 3;
  if (dir === 'down' || dir === 'up') {
    // legs + shoes (grounded, no bob)
    if (!sit) {
      const lh = stepA ? 4 : stepB ? 2 : 3, rh = stepB ? 4 : stepA ? 2 : 3;
      t.rect(5, 19, 3, lh, K.pants); t.vline(5, 19, lh, K.pantsShade);
      t.rect(8, 19, 3, rh, K.pants); t.vline(10, 19, rh, K.pantsShade);
      t.rect(5, 19 + lh, 3, 1, SHOE); t.rect(8, 19 + rh, 3, 1, SHOE);
    }
    // torso
    t.rect(4, 13 + bob, 8, 7, K.shirt); t.vline(4, 13 + bob, 7, K.shirtShade); t.vline(11, 13 + bob, 7, K.shirtShade);
    t.hline(4, 19 + bob, 8, K.shirtShade);
    // arms swing
    const la = stepA ? 1 : stepB ? -1 : 0, ra = -la;
    t.rect(3, 13 + bob, 1, 4 + la, K.shirtShade); t.px(3, 17 + bob + la, K.skin);
    t.rect(12, 13 + bob, 1, 4 + ra, K.shirtShade); t.px(12, 17 + bob + ra, K.skin);
    if (dir === 'down') { t.hline(7, 13 + bob, 2, K.skin); }
    if (sit && dir === 'down') { // lap toward the viewer, feet dangling
      t.rect(4, 20, 8, 2, K.pants); t.hline(4, 21, 8, K.pantsShade); t.vline(8, 20, 2, K.pantsShade);
      t.rect(5, 22, 2, 1, SHOE); t.rect(9, 22, 2, 1, SHOE);
    }
    // head
    const hy = 2 + bob;
    t.rect(3, hy + 2, 10, 9, K.skin); t.hline(4, hy + 1, 8, K.skin); t.hline(4, hy + 11, 8, K.skinShade);
    if (dir === 'down') {
      // hair cap + bangs + sides
      t.hline(4, hy - 1, 8, K.hair); t.rect(3, hy, 10, 3, K.hair); t.hline(2, hy + 1, 12, K.hairShade);
      t.rect(2, hy + 1, 12, 2, K.hair);
      t.rect(3, hy + 3, 3, 1, K.hair); t.rect(9, hy + 3, 4, 1, K.hair); t.px(6, hy + 3, K.hairShade);
      t.vline(2, hy + 3, 5, K.hairShade); t.vline(13, hy + 3, 5, K.hairShade);
      t.hline(3, hy + 4, 10, K.skinShade); t.rect(4, hy + 4, 8, 1, K.skin);
      t.vline(5, hy + 6, 2, EYE); t.vline(10, hy + 6, 2, EYE);
      t.px(4, hy + 8, BLUSH); t.px(11, hy + 8, BLUSH);
      t.hline(7, hy + 9, 2, K.skinShade);
    } else {
      t.hline(4, hy - 1, 8, K.hair); t.rect(2, hy, 12, 10, K.hair);
      t.vline(2, hy + 1, 9, K.hairShade); t.vline(13, hy + 1, 9, K.hairShade); t.hline(3, hy + 9, 10, K.hairShade);
      t.px(5, hy + 2, K.hairShade); t.px(9, hy + 4, K.hairShade);
    }
    if (style === 'long') {
      if (dir === 'down') { t.rect(2, hy + 3, 2, 10, K.hair); t.rect(12, hy + 3, 2, 10, K.hair); t.vline(2, hy + 3, 10, K.hairShade); t.vline(13, hy + 3, 10, K.hairShade); }
      else { t.rect(3, hy + 9, 10, 5, K.hair); t.hline(3, hy + 13, 10, K.hairShade); }
    }
    if (style === 'ponytail' && dir === 'up') {
      t.rect(6, hy + 8, 4, 6, K.hair); t.vline(9, hy + 9, 4, K.hairShade);
      t.hline(6, hy + 7, 4, '#b4534a');
    }
  } else { // left (right is mirrored)
    const front = stepA ? -2 : stepB ? 1 : 0, back = stepA ? 2 : stepB ? -1 : 0;
    // back leg
    const backH = stepB ? 4 : stepA ? 2 : 3, frontH = stepA ? 4 : stepB ? 2 : 3;
    if (!sit) { t.rect(8 + back, 19, 2, backH, K.pantsShade); t.rect(7 + back, 19 + backH, 3, 1, SHOE); }
    // torso
    t.rect(5, 13 + bob, 6, 7, K.shirt); t.vline(10, 13 + bob, 7, K.shirtShade); t.hline(5, 19 + bob, 6, K.shirtShade);
    // front leg (seated: thigh forward, shin down)
    if (sit) { t.rect(3, 19, 7, 2, K.pants); t.hline(3, 20, 7, K.pantsShade); t.rect(3, 21, 2, 1, K.pants); t.rect(2, 22, 3, 1, SHOE); }
    else { t.rect(6 + front, 19, 2, frontH, K.pants); t.rect(5 + front, 19 + frontH, 3, 1, SHOE); }
    // arm
    const ax = sit ? 6 : stepA ? 9 : stepB ? 6 : 7;
    t.rect(ax, 14 + bob, 2, 3, K.shirtShade); t.hline(ax, 17 + bob, 2, K.skin);
    // head (profile facing left)
    const hy = 2 + bob;
    t.rect(3, hy + 2, 10, 9, K.skin); t.hline(4, hy + 1, 8, K.skin); t.hline(4, hy + 11, 8, K.skinShade);
    t.px(2, hy + 6, K.skin); // nose
    t.hline(4, hy - 1, 8, K.hair); t.rect(3, hy, 10, 3, K.hair); t.rect(2, hy + 1, 3, 2, K.hair);
    t.rect(8, hy + 2, 5, 7, K.hair); t.vline(13, hy + 1, 8, K.hairShade); t.hline(8, hy + 9, 5, K.hairShade);
    t.px(9, hy + 6, K.skin); t.px(9, hy + 7, K.skinShade); // ear
    t.vline(4, hy + 5, 2, EYE); t.px(5, hy + 8, BLUSH);
    if (style === 'long') { t.rect(9, hy + 9, 4, 6, K.hair); t.vline(12, hy + 9, 6, K.hairShade); }
    if (style === 'ponytail') {
      t.rect(12, hy + 9, 3, 5, K.hair); t.vline(14, hy + 10, 4, K.hairShade);
      t.hline(12, hy + 8, 3, '#b4534a');
    }
  }
  if (top === 1 && dir === 'down') { // front-facing button-up; the neck stays like the T-shirt
    t.px(7, 14 + bob, '#e8dcc8');
    t.px(7, 16 + bob, '#e8dcc8');
  } else if (top === 2) { // sweater band and cuffs
    t.hline(dir === 'down' || dir === 'up' ? 4 : 5, 18 + bob, dir === 'down' || dir === 'up' ? 8 : 6, K.shirtShade);
    t.px(dir === 'down' ? 3 : 6, 16 + bob, K.shirt);
    t.px(dir === 'down' ? 12 : 10, 16 + bob, K.shirt);
  }
  if (bottom === 1) { // skirt silhouette over the legs
    if (dir === 'down' || dir === 'up') {
      t.rect(4, 19, 8, 3, K.pants); t.hline(4, 21, 8, K.pantsShade); t.vline(8, 19, 3, K.pantsShade);
    } else {
      t.rect(4, 19, 8, 3, K.pants); t.hline(4, 21, 8, K.pantsShade);
    }
  } else if (bottom === 2) { // shorts: raised hem on each leg
    if (dir === 'down' || dir === 'up') { t.hline(5, 20, 3, K.pantsShade); t.hline(8, 20, 3, K.pantsShade); }
    else t.hline(5, 20, 5, K.pantsShade);
  }
  return t.outline();
}

const CW = 16, CH = 24, FPD = 6; // idle, 4 walk, sit
const chars = new Img(CW * FPD, CH * DIRS.length * STYLES.length * TOPS.length * BOTTOMS.length);
const accessories = new Img(CW, CH * ACCESSORY_ITEMS.length * DIRS.length);
function drawAccessory(item, dir) {
  const a = new Img(CW, CH), primary = ACCESSORY_KEYS.primary, light = ACCESSORY_KEYS.highlight;
  if (item.endsWith('glasses')) {
    const round = item === 'round_glasses';
    if (dir === 'down') {
      if (round) {
        a.hline(4, 7, 4, primary); a.px(3, 8, primary); a.px(3, 9, light); a.px(4, 10, primary); a.hline(5, 8, 2, light);
        a.hline(9, 7, 4, primary); a.px(8, 8, primary); a.px(8, 9, light); a.px(9, 10, primary); a.hline(10, 8, 2, light);
      } else {
        a.hline(4, 7, 4, primary); a.vline(3, 8, 2, primary); a.vline(7, 8, 2, primary); a.hline(4, 10, 4, primary); a.hline(4, 8, 3, light);
        a.hline(9, 7, 4, primary); a.vline(8, 8, 2, primary); a.vline(12, 8, 2, primary); a.hline(9, 10, 4, primary); a.hline(9, 8, 3, light);
      }
      a.hline(7, 8, 2, primary); a.px(4, 8, primary); a.px(13, 8, primary);
    } else if (dir === 'left' || dir === 'right') {
      const x = dir === 'left' ? 3 : 9;
      a.hline(x, 7, 4, primary); a.vline(x, 8, 2, primary); a.vline(x + 3, 8, 2, primary); a.hline(x, 10, 4, primary);
      a.hline(x + 1, 8, 2, light); a.px(dir === 'left' ? 7 : 8, 8, primary);
      if (round) { a.px(x, 9, light); a.px(x + 3, 9, light); }
    }
    return a;
  }
  if (item === 'cap') {
    if (dir === 'down') {
      // Full crown wraps over the scalp; the lower bill projects toward the viewer.
      a.hline(5, 0, 6, OUT); a.rect(3, 1, 10, 4, OUT); a.rect(2, 3, 2, 3, OUT); a.rect(12, 3, 2, 3, OUT);
      a.hline(4, 6, 8, OUT); a.hline(5, 1, 6, primary); a.rect(4, 2, 8, 2, primary);
      a.vline(3, 4, 2, primary); a.vline(12, 4, 2, primary); a.hline(4, 5, 8, primary);
      a.hline(4, 6, 8, light); a.hline(5, 2, 4, light); a.vline(4, 3, 2, light);
    } else if (dir === 'up') {
      // Back view keeps the same crown height and width, with a short rear band.
      a.hline(5, 0, 6, OUT); a.rect(3, 1, 10, 4, OUT); a.hline(4, 5, 8, OUT);
      a.hline(5, 1, 6, primary); a.rect(4, 2, 8, 2, primary); a.hline(5, 4, 6, primary);
      a.hline(7, 4, 2, light); a.hline(5, 2, 4, light);
    } else {
      const left = dir === 'left';
      // Side profile: the crown covers the back hair down to the ear, while the bill
      // projects two pixels past the face in the direction the character is looking.
      if (left) {
        a.hline(5, 0, 7, OUT); a.rect(3, 1, 11, 5, OUT); a.rect(12, 3, 3, 5, OUT); a.rect(2, 3, 2, 3, OUT);
        a.hline(5, 1, 7, primary); a.rect(3, 2, 10, 4, primary); a.hline(4, 5, 9, primary);
        a.vline(12, 5, 3, primary); a.vline(13, 4, 3, primary); a.vline(3, 4, 2, primary);
        a.hline(6, 2, 5, light); a.vline(4, 3, 2, light); a.hline(0, 6, 9, OUT); a.hline(1, 7, 7, OUT);
        a.hline(0, 6, 8, primary); a.hline(1, 7, 6, primary); a.hline(2, 7, 3, light);
      } else {
        a.hline(4, 0, 7, OUT); a.rect(2, 1, 11, 5, OUT); a.rect(1, 3, 3, 5, OUT); a.rect(12, 3, 2, 3, OUT);
        a.hline(4, 1, 7, primary); a.rect(3, 2, 9, 3, primary); a.vline(2, 4, 3, primary); a.vline(12, 4, 2, primary);
        a.hline(5, 2, 5, light); a.vline(11, 3, 2, light); a.hline(7, 6, 9, OUT); a.hline(8, 7, 7, OUT);
        a.hline(8, 6, 8, primary); a.hline(9, 7, 6, primary); a.hline(11, 7, 3, light);
      }
      a.hline(5, 2, 4, light);
    }
    return a;
  }
  // Bowler: round crown and a short brim whose direction follows the facing.
  a.hline(5, 0, 6, primary); a.rect(4, 1, 8, 2, primary);
  a.hline(dir === 'left' ? 3 : dir === 'right' ? 6 : 3, 3, dir === 'left' || dir === 'right' ? 10 : 10, primary);
  a.hline(6, 1, 4, light); a.px(5, 2, light);
  return a;
}
ACCESSORY_ITEMS.forEach((item, ai) => DIRS.forEach((dir, di) => accessories.blit(drawAccessory(item, dir), 0, (ai * DIRS.length + di) * CH)));
STYLES.forEach((style, si) => TOPS.forEach((top, ti) => BOTTOMS.forEach((bottom, bi) => DIRS.forEach((dir, di) => {
  for (let f = 0; f < FPD; f++) {
    let img = drawChar(style, dir === 'right' ? 'left' : dir, f, ti, bi);
    if (dir === 'right') img = img.mirror();
    const row = ((si * TOPS.length + ti) * BOTTOMS.length + bi) * DIRS.length + di;
    chars.blit(img, f * CW, row * CH);
  }
}))));

// ---------- outside + plants (own noise, so the shared rnd() sequence above stays put) ----------
const noise = (x, y, k) => (((x * 73856093) ^ (y * 19349663) ^ (k * 83492791)) >>> 0) % 100;
for (let v = 0; v < 3; v++) { // grass
  const t = new Img(16, 16);
  t.rect(0, 0, 16, 16, '#6f9e4a');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const n = noise(x, y, v + 1);
    if (n < 9) t.px(x, y, '#5e8a3e'); else if (n < 15) t.px(x, y, '#82b25a');
  }
  for (let i = 0; i < 3; i++) { const x = (i * 5 + v * 4 + 2) % 15, y = (i * 7 + v * 3 + 3) % 14; t.vline(x, y, 2, '#4f7a34'); t.px(x + 1, y, '#4f7a34'); }
  if (v === 2) { t.px(11, 4, '#f0e070'); t.px(4, 11, '#f4f0f0'); }
  frames[`grass_${v}`] = t;
}
for (let v = 0; v < 2; v++) { // stepping-stone path
  const t = new Img(16, 16);
  t.rect(0, 0, 16, 16, '#6f9e4a');
  t.rect(0, 0, 16, 16, '#c8b48e');
  for (const [x, y, w, h] of v ? [[1, 1, 6, 6], [9, 2, 6, 5], [2, 9, 5, 6], [8, 9, 7, 6]] : [[1, 2, 7, 5], [10, 1, 5, 6], [1, 9, 6, 6], [9, 9, 6, 5]]) {
    t.rect(x, y, w, h, '#dccaa4'); t.hline(x, y, w, '#ebdcbc'); t.hline(x, y + h - 1, w, '#b09c78');
  }
  frames[`path_${v}`] = t;
}
{
  const t = new Img(16, 16); // the building's outside wall: brick
  t.rect(0, 0, 16, 16, '#a9604a');
  for (let row = 0; row < 4; row++) {
    const y = row * 4; t.hline(0, y + 3, 16, '#7e4434');
    for (let x = row % 2 ? 0 : 4; x < 16; x += 8) t.vline(x, y, 3, '#7e4434');
    t.hline(0, y, 16, '#b97058');
  }
  t.rect(0, 0, 16, 2, '#7a4b34'); t.hline(0, 2, 16, '#c99f6e');
  frames.wall_face_ext = t;
}
{
  const t = new Img(16, 16); // hedge
  t.rect(0, 0, 16, 16, '#3f6a30');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = noise(x, y, 7); if (n < 18) t.px(x, y, '#52823c'); else if (n < 24) t.px(x, y, '#2f5224'); }
  frames.hedge = t;
}
{
  const t = new Img(64, 24); // plant shelf: a slatted wooden bench, pots stand on top
  t.rect(1, 8, 62, 6, W1); t.hline(1, 8, 62, W1L); t.hline(1, 11, 62, W1D);
  t.rect(1, 14, 62, 3, W1D); t.hline(1, 16, 62, W1DD);
  for (const x of [3, 31, 59]) t.rect(x, 17, 2, 6, W1DD);
  frames.plant_shelf = t.outline();
}
{
  const t = new Img(32, 48); // tree: round crown over a trunk on one tile
  t.rect(13, 30, 6, 16, '#7d4a26'); t.vline(14, 30, 16, '#9c5f30'); t.hline(11, 45, 10, '#5a3a20');
  for (const [x, y, rx, ry, c] of [[16, 18, 14, 13, '#3f6a30'], [16, 16, 12, 11, '#4a7e3a'], [12, 12, 7, 6, '#5f9a48'], [21, 20, 6, 5, '#5f9a48'], [11, 9, 3, 3, '#7bb85a']]) t.ellipse(x, y, rx, ry, c);
  for (const [x, y] of [[9, 20], [22, 11], [17, 25], [6, 15]]) t.px(x, y, '#8cc864');
  frames.tree = t.outline();
}
{
  const t = new Img(32, 20); // flower bed
  t.rect(1, 8, 30, 10, '#6a4a30'); t.hline(1, 8, 30, '#8a6040'); t.rect(2, 10, 28, 6, '#4a3424');
  const C = ['#e87a8a', '#f0d050', '#b080d8', '#f4f0f0', '#e89a50'];
  for (let i = 0; i < 9; i++) {
    const x = 3 + i * 3, y = 4 + (i % 3);
    t.vline(x + 1, y + 2, 10 - y, '#4a7e3a'); t.px(x + 2, y + 5, '#5f9a48');
    t.rect(x, y, 3, 2, C[i % C.length]); t.px(x + 1, y, '#fff0a0');
  }
  frames.flowerbed = t.outline();
}
{
  const t = new Img(64, 32); // pond
  t.ellipse(32, 16, 31, 15, '#9a8a70'); t.ellipse(32, 16, 28, 12.5, '#4a88b0'); t.ellipse(30, 14, 22, 8, '#5a9cc4');
  t.hline(18, 10, 10, '#a8d4ec'); t.hline(36, 19, 8, '#a8d4ec');
  t.ellipse(44, 13, 4, 2.5, '#5f9a48'); t.px(45, 12, '#f4b0c0'); t.ellipse(20, 20, 3, 2, '#5f9a48');
  t.rect(26, 15, 3, 2, '#e89a50'); t.px(29, 16, '#e89a50');
  frames.pond = t.outline();
}
{
  const t = new Img(48, 20); // garden bench
  t.rect(2, 2, 44, 3, W1D); t.hline(2, 2, 44, W1); t.rect(2, 6, 44, 3, W1D); t.hline(2, 6, 44, W1);
  t.rect(1, 10, 46, 5, W1); t.hline(1, 10, 46, W1L); t.hline(1, 14, 46, W1DD);
  for (const x of [3, 43]) t.rect(x, 2, 2, 17, '#3a3a40');
  frames.bench = t.outline();
}
// someone's plant, stage 0 (just planted) … 5 (in bloom), and withered: a small pot that sits on a desk or a shelf
const pot = (draw) => {
  const t = new Img(12, 20);
  draw(t);
  t.rect(3, 14, 6, 5, '#c0643c'); t.hline(2, 13, 8, '#d8805a'); t.hline(3, 18, 6, '#9a4a2a'); t.vline(4, 15, 3, '#d8805a');
  t.hline(3, 13, 6, '#5a3a20');
  return t.outline();
};
const G = '#5f9a48', GD = '#4a7e3a', GL = '#8cc864';
frames.pot_0 = pot(t => { t.px(6, 12, GL); t.px(5, 11, GL); });
frames.pot_1 = pot(t => { t.vline(6, 9, 4, G); t.rect(4, 9, 2, 1, GL); t.rect(7, 8, 2, 1, GL); });
frames.pot_2 = pot(t => { t.vline(6, 6, 7, G); t.ellipse(4.5, 9, 2, 1.2, G); t.ellipse(8, 7, 2, 1.2, G); t.px(6, 5, GL); });
frames.pot_3 = pot(t => { t.vline(6, 5, 8, GD); t.ellipse(6, 7, 4, 3, G); t.ellipse(4, 10, 2.5, 1.5, GD); t.ellipse(8.5, 10, 2.5, 1.5, GD); t.px(5, 5, GL); t.px(8, 7, GL); });
frames.pot_4 = pot(t => { t.vline(6, 3, 10, GD); t.ellipse(6, 7, 5, 4, G); t.ellipse(4, 10, 3, 1.8, GD); t.ellipse(8.5, 10, 3, 1.8, GD); t.px(4, 6, GL); t.px(8, 8, GL); t.rect(5, 1, 2, 3, '#e87a8a'); });
frames.pot_5 = pot(t => {
  t.vline(6, 4, 9, GD); t.ellipse(6, 8, 5, 4, G); t.ellipse(4, 11, 3, 1.8, GD); t.ellipse(8.5, 11, 3, 1.8, GD); t.px(8, 9, GL);
  for (const [x, y] of [[6, 1], [4, 3], [8, 3], [6, 5], [4, 0], [8, 0]]) t.px(x, y, '#e87a8a');
  t.rect(5, 2, 3, 2, '#f0a0b0'); t.px(6, 3, '#f8e070');
});
frames.pot_dead = pot(t => { t.vline(6, 7, 6, '#8a7048'); t.px(5, 7, '#8a7048'); t.px(4, 8, '#8a7048'); t.px(7, 9, '#a08a58'); t.px(8, 10, '#a08a58'); t.px(3, 9, '#6a5438'); });
// what a plant turns into from stage 3 (leafy, budding, in bloom): pot_<kind>_<stage>; stages 0-2 are the shared seedling
{
  const CACT = '#5a9a58', CACTD = '#3f7a40';
  const tulipLeaves = t => { t.ellipse(3.5, 10, 2, 3, G); t.ellipse(8.5, 10.5, 2, 2.5, G); t.vline(3, 8, 4, GD); t.vline(9, 9, 3, GD); t.px(2, 8, GL); };
  const tulip = (c, cd) => [
    pot(t => { t.vline(6, 5, 8, GD); tulipLeaves(t); t.ellipse(6, 4.5, 1.2, 1.8, G); }),
    pot(t => { t.vline(6, 4, 9, GD); tulipLeaves(t); t.ellipse(6, 3, 1.5, 2.2, c); t.px(6, 2, cd); }),
    pot(t => { t.vline(6, 5, 8, GD); tulipLeaves(t); t.rect(4, 1, 5, 4, c); t.px(4, 0, c); t.px(6, 0, c); t.px(8, 0, c); t.vline(6, 1, 4, cd); t.hline(5, 4, 3, cd); }),
  ];
  const daisyBush = t => { t.ellipse(6, 10, 4.5, 3, G); t.ellipse(6, 11, 3, 2, GD); t.px(4, 8, GL); t.px(8, 9, GL); };
  const kinds = {
    tulip_red: tulip('#d84a4a', '#a83030'), tulip_yellow: tulip('#f0c838', '#c89a20'), tulip_pink: tulip('#f08ab0', '#c8608a'),
    daisy: [
      pot(t => { daisyBush(t); t.vline(5, 6, 3, GD); t.vline(8, 7, 2, GD); }),
      pot(t => { for (const [x, y] of [[3, 4], [6, 3], [9, 5]]) { t.vline(x, y + 1, 9 - y, GD); t.rect(x - 1, y - 1, 2, 2, '#f4f4e8'); t.px(x - 1, y, '#c8c8b0'); } daisyBush(t); }),
      pot(t => { daisyBush(t); for (const [x, y] of [[3, 4], [8, 3], [6, 7]]) { t.px(x, y - 1, '#ffffff'); t.px(x, y + 1, '#ffffff'); t.px(x - 1, y, '#ffffff'); t.px(x + 1, y, '#ffffff'); t.px(x, y, '#f0c030'); } }),
    ],
    sunflower: [
      pot(t => { t.vline(6, 4, 9, GD); t.vline(7, 4, 9, G); t.ellipse(4, 8, 2, 1.5, G); t.ellipse(9, 10, 2, 1.5, G); }),
      pot(t => { t.vline(6, 3, 10, GD); t.ellipse(4, 8, 2, 1.5, G); t.ellipse(9, 10, 2, 1.5, G); t.ellipse(6, 2.5, 2, 2, '#6a8a3a'); t.px(5, 1, '#f0c030'); t.px(7, 1, '#f0c030'); }),
      pot(t => { t.vline(6, 5, 8, GD); t.ellipse(3.5, 9, 2, 1.5, G); t.ellipse(9, 10, 2, 1.5, G); t.ellipse(6, 3, 5, 3.5, '#f0c030'); t.ellipse(6, 3, 2.5, 2, '#6a4020'); t.px(5, 2, '#8a5a30'); }),
    ],
    cactus: [0, 1, 2].map(st => pot(t => {
      t.rect(5, 5 - (st ? 1 : 0), 3, 8 + (st ? 1 : 0), CACT); t.vline(6, 5 - (st ? 1 : 0), 8 + (st ? 1 : 0), CACTD);
      t.rect(3, 8, 2, 2, CACT); t.vline(3, 6, 2, CACT); t.rect(8, 9, 2, 2, CACT); t.vline(9, 7, 2, CACT);
      if (st === 1) t.rect(5, 2, 3, 2, '#e87a9a');
      if (st === 2) { t.rect(4, 1, 5, 3, '#e87a9a'); t.px(3, 2, '#e87a9a'); t.px(9, 2, '#e87a9a'); t.px(6, 2, '#f8e070'); t.px(3, 6, '#f4b0c0'); }
    })),
    lavender: [
      pot(t => { for (const x of [4, 6, 8]) t.vline(x, x === 6 ? 5 : 7, x === 6 ? 8 : 6, G); t.px(3, 10, GL); t.px(9, 11, GL); }),
      pot(t => { for (const x of [3, 5, 7, 9]) { t.vline(x, 4 + (x % 3), 9 - (x % 3), G); t.vline(x, 3 + (x % 3), 2, '#8a7ab8'); } }),
      pot(t => { for (const x of [3, 5, 7, 9]) { t.vline(x, 5 + (x % 3), 8 - (x % 3), G); t.vline(x, 1 + (x % 3), 5, '#9a70d0'); t.px(x, 1 + (x % 3), '#c0a0f0'); } }),
    ],
  };
  for (const [k, fs] of Object.entries(kinds)) fs.forEach((f, i) => { frames[`pot_${k}_${i + 3}`] = f; });
}

// ---------- room doors (drawn by the engine, never furniture) ----------
for (const axis of ['h', 'v']) for (const open of [false, true]) {
  const t = new Img(axis === 'h' ? 32 : 16, 40), w = t.w;
  t.rect(1, 7, w - 2, 32, OUT);
  t.rect(3, 8, w - 6, 29, '#805033');
  t.rect(4, 9, w - 8, 27, '#c28a50');
  // The open panel turns against its hinge, leaving the gap transparent.
  if (open) {
    t.rect(4, 10, w - 8, 27, [0, 0, 0, 0]);
    if (axis === 'h') {
      t.rect(3, 10, 7, 26, OUT); t.rect(4, 11, 4, 24, '#b77b43');
      t.vline(5, 12, 22, '#dfa76a'); t.px(7, 24, '#edce76');
    } else {
      t.rect(3, 9, 10, 7, OUT); t.rect(4, 10, 8, 4, '#b77b43');
      t.hline(4, 10, 8, '#dfa76a'); t.px(10, 13, '#edce76');
    }
  } else {
    for (let x = 5; x < w - 4; x += 5) { t.vline(x, 10, 25, '#9b6339'); t.vline(x + 1, 10, 25, '#d59b5c'); }
    t.hline(4, 12, w - 8, '#e0ae73'); t.hline(4, 32, w - 8, '#805033');
    t.rect(w - 7, 24, 2, 2, '#edce76');
  }
  t.hline(2, 7, w - 4, '#dfa76a');
  frames[`door_${axis}_${open ? 'open' : 'closed'}`] = t;
}

// ---------- Arcade + Deck Park (no shared random calls: existing art stays unchanged) ----------
const cabinet = (lit = 0) => {
  const t = new Img(16, 32);
  t.rect(2, 1, 12, 28, '#4f7772'); t.hline(3, 1, 10, '#80aaa0');
  t.rect(3, 2, 10, 4, W1D); t.hline(4, 3, 8, '#f2b45a'); t.px(6, 4, '#f2b45a'); t.px(9, 4, '#f2b45a');
  t.rect(3, 7, 10, 10, OUT); t.rect(4, 8, 8, 8, lit ? '#457b77' : '#20232d');
  if (lit) {
    t.hline(5, 9, 6, lit === 1 ? '#a0d8b0' : '#8cc4b0');
    t.rect(5 + (lit - 1) * 2, 12, 2, 3, '#f2b45a'); t.hline(4, 15, 8, '#8cc864');
  } else t.hline(5, 9, 5, '#343847');
  t.rect(1, 18, 14, 4, W1D); t.hline(2, 18, 12, W1L);
  t.vline(5, 17, 3, OUT); t.px(5, 17, '#d86a5a'); t.px(10, 19, '#f2b45a'); t.px(12, 19, '#d86a5a');
  t.rect(3, 23, 10, 6, '#38605c'); t.rect(7, 24, 3, 2, OUT); t.hline(3, 29, 10, W1DD);
  t.rect(2, 30, 3, 1, OUT); t.rect(11, 30, 3, 1, OUT);
  return t.outline();
};
frames.arcade = cabinet(); frames.arcade_on = cabinet(1);
frames.arcade_on_1 = cabinet(1); frames.arcade_on_2 = cabinet(2);
{
  const t = new Img(32, 16);
  t.rect(1, 1, 30, 14, W1D); t.hline(2, 1, 28, W1L); t.rect(3, 3, 26, 10, '#355451');
  t.rect(5, 5, 4, 3, '#f2b45a'); t.px(4, 5, '#f2b45a'); t.px(9, 5, '#f2b45a'); t.vline(6, 8, 2, '#f2b45a'); t.hline(5, 10, 4, '#f2b45a');
  for (let y = 5; y <= 11; y += 3) { t.hline(12, y, 14, '#e8dcc8'); t.px(12, y, '#f2b45a'); }
  frames.records = t.outline();
}
frames.bubble_game = bubble(t => { t.rect(3, 7, 8, 2, '#4f7772'); t.vline(6, 4, 3, OUT); t.rect(5, 2, 3, 3, '#d86a5a'); t.px(9, 6, '#f2b45a'); });
frames.bubble_watch = bubble(t => { for (const x of [3, 8]) { t.rect(x, 3, 3, 5, '#d8c8b0'); t.rect(x + 1, 4, 2, 3, '#fff'); t.vline(x + 1, 4, 2, OUT); } });
const parkTile = (name, draw, w = 16, h = 16) => { const t = new Img(w, h); draw(t); frames[`park_${name}`] = t.outline(); };
for (const top of [true, false]) parkTile(top ? 'ground' : 'dirt', t => {
  t.rect(0, 0, 16, 16, W1D); t.hline(0, 15, 16, W1DD);
  for (const [x, y] of [[2, 7], [9, 11], [5, 14], [13, 5]]) { t.hline(x, y, 2, W1); t.px(x, y + 1, W1DD); }
  if (top) { t.rect(0, 0, 16, 3, '#5f9a48'); t.hline(0, 0, 16, '#8cc864'); for (const x of [1, 5, 10, 14]) t.vline(x, 2, 3, '#4a7e3a'); }
});
parkTile('brick', t => { t.rect(0, 0, 16, 16, '#b97058'); for (let y = 0; y < 16; y += 4) { t.hline(0, y, 16, '#d79878'); t.hline(0, y + 3, 16, '#7e4434'); for (let x = y % 8 ? 0 : 4; x < 16; x += 8) t.vline(x, y, 4, '#7e4434'); } });
parkTile('oneway', t => { t.rect(0, 0, 16, 4, W1); t.hline(0, 0, 16, W1L); t.hline(0, 3, 16, W1DD); for (const x of [3, 11]) t.px(x, 2, '#edce76'); });
parkTile('spikes', t => { for (const x of [0, 5, 10]) for (let y = 0; y < 7; y++) t.hline(x + 2 - Math.floor(y / 3), 8 + y, 1 + Math.floor(y / 3) * 2, y < 3 ? '#e8dcc8' : '#9b9ca6'); t.hline(0, 15, 16, '#5a5a6e'); });
parkTile('key', t => { t.rect(3, 4, 6, 6, '#f2b45a'); t.rect(5, 6, 2, 2, OUT); t.hline(8, 7, 6, '#f2b45a'); t.vline(11, 8, 3, '#f2b45a'); t.vline(13, 8, 2, '#f2b45a'); t.hline(4, 4, 4, '#ffe08a'); });
for (const open of [false, true]) parkTile(`door_${open ? 'open' : 'closed'}`, t => {
  t.rect(1, 0, 14, 32, W1DD); t.rect(3, 2, 10, 29, open ? '#21161f' : W1); t.hline(2, 1, 12, W1L);
  if (open) { t.rect(3, 3, 3, 27, W1D); t.vline(4, 4, 24, W1L); t.px(5, 19, '#edce76'); }
  else { t.rect(5, 5, 6, 10, W1D); t.rect(5, 18, 6, 10, W1D); t.rect(10, 17, 2, 2, '#edce76'); }
}, 16, 32);
for (const down of [false, true]) parkTile(`button_${down ? 'down' : 'up'}`, t => {
  t.rect(1, 13, 14, 3, W1DD); t.rect(3, down ? 13 : 10, 10, down ? 1 : 4, down ? '#5f9a48' : '#d86a5a'); t.hline(3, down ? 13 : 10, 10, down ? '#8cc864' : '#f0a080');
});
parkTile('start', t => { t.rect(0, 0, 16, 16, '#38605c'); t.hline(0, 0, 16, '#8cc864'); t.hline(0, 15, 16, OUT); t.rect(2, 3, 12, 9, '#4f7772'); });
for (const left of [true, false]) parkTile(`select_${left ? 'left' : 'right'}`, t => {
  t.rect(1, 1, 14, 14, W1); t.hline(2, 1, 12, W1L); t.hline(2, 14, 12, W1DD);
  for (let y = -3; y <= 3; y++) t.hline(left ? 5 + Math.abs(y) : 5, 8 + y, 4 - Math.abs(y), '#fff4e0');
});
parkTile('box', t => { t.rect(1, 1, 14, 14, W1); t.rect(3, 3, 10, 10, W1D); for (let i = 0; i < 10; i++) { t.px(3 + i, 3 + i, W1L); t.px(12 - i, 3 + i, W1L); } t.hline(2, 1, 12, W1L); });
for (const kind of ['lift', 'platform']) for (const segment of ['left', 'middle', 'right']) parkTile(`${kind}_${segment}`, t => {
  t.rect(0, 0, 16, 16, kind === 'lift' ? '#6c7380' : '#4f7772'); t.hline(0, 0, 16, kind === 'lift' ? '#b4bac4' : '#80aaa0'); t.hline(0, 15, 16, OUT);
  t.rect(0, 6, 16, 4, kind === 'lift' ? '#4b5060' : '#38605c');
  if (segment !== 'middle') { const x = segment === 'left' ? 2 : 12; t.vline(x, 2, 12, '#edce76'); t.px(x, 4, OUT); t.px(x, 11, OUT); }
});
parkTile('gate', t => { t.hline(0, 0, 16, '#b4bac4'); t.hline(0, 15, 16, '#4b5060'); for (const x of [2, 7, 12]) { t.rect(x, 1, 2, 14, '#6c7380'); t.vline(x, 1, 14, '#b4bac4'); } });
for (const letter of ['s', 't']) for (const solid of [true, false]) parkTile(`${letter}_${solid ? 'solid' : 'ghost'}`, t => {
  const c = letter === 's' ? '#8a7ab8' : '#4f9a92';
  if (solid) { t.rect(1, 1, 14, 14, c); t.hline(2, 1, 12, '#d8c8e0'); t.hline(2, 14, 12, OUT); }
  else for (let i = 1; i < 15; i += 3) { t.hline(i, 1, 2, c); t.hline(i, 14, 2, c); t.vline(1, i, 2, c); t.vline(14, i, 2, c); }
  const glyph = letter === 's' ? ['111', '100', '111', '001', '111'] : ['111', '010', '010', '010', '010'];
  glyph.forEach((row, y) => [...row].forEach((v, x) => { if (v === '1') t.px(6 + x, 5 + y, solid ? '#fff4e0' : c); }));
});
for (let f = 1; f <= 4; f++) parkTile(`coin_${f}`, t => {
  const radius = [4, 2, 1, 2][f - 1]; t.ellipse(8, 8, radius, 6, '#d0a040'); t.ellipse(8, 7, Math.max(1, radius - 1), 4, '#f2b45a'); t.vline(7, 4, 6, '#ffe08a');
});
for (let f = 1; f <= 2; f++) parkTile(`walker_${f}`, t => {
  t.rect(3, 4, 10, 8, '#b4534a'); t.hline(5, 3, 6, '#d8805a'); t.rect(4, 6, 3, 3, '#fff4e0'); t.rect(9, 6, 3, 3, '#fff4e0'); t.px(5, 7, OUT); t.px(10, 7, OUT);
  t.rect(f === 1 ? 2 : 3, 12, 4, 2, W1DD); t.rect(f === 1 ? 10 : 9, 12, 4, 2, W1DD);
});
for (const up of [false, true]) parkTile(`flag_${up ? 'up' : 'down'}`, t => {
  t.vline(4, 1, 22, '#e8dcc8'); t.hline(2, 23, 7, W1D); t.px(4, 0, '#f2b45a');
  t.rect(5, up ? 2 : 13, 8, 5, up ? '#8cc864' : '#a8917c'); t.hline(5, up ? 2 : 13, 6, up ? '#c5e4a0' : '#c8b8a4');
}, 16, 24);
parkTile('railing', t => { t.hline(0, 1, 16, W1L); t.rect(0, 2, 16, 2, W1D); t.vline(2, 4, 4, W1); t.vline(12, 4, 4, W1); t.hline(0, 7, 16, W1DD); }, 16, 8);
// ---------- the cool stone maze under the garden ----------
for (let v = 0; v < 3; v++) {
  const t = new Img(16, 16); t.rect(0, 0, 16, 16, '#252d3c');
  for (let row = 0; row < 4; row++) for (let col = -1; col < 3; col++) {
    const x = col * 8 + (row % 2) * 4 + (v + row) % 2, y = row * 4;
    t.rect(x, y, 7, 3, '#424e60'); t.hline(x + 1, y, 5, '#536074'); t.hline(x, y + 2, 7, '#343e50');
    t.px(x + 2 + v, y + 1, '#48566a');
  }
  t.px(3 + v * 4, 6, '#263344'); frames[`dungeon_floor_${v}`] = t;
}
for (const face of [false, true]) {
  const t = new Img(16, 16); t.rect(0, 0, 16, 16, OUT);
  t.rect(1, 1, 14, face ? 6 : 14, '#596579'); t.hline(1, 1, 14, '#748095');
  t.hline(1, face ? 6 : 14, 14, '#3b475b'); t.vline(8, 2, face ? 4 : 12, '#445064');
  t.px(4, 4, '#67758b'); t.px(12, 3, '#48566a');
  if (face) {
    t.rect(1, 8, 14, 7, '#3e495d'); t.hline(1, 8, 14, '#67738a');
    t.hline(1, 14, 14, '#2c3547'); t.vline(5, 9, 5, '#2b3445'); t.px(11, 10, '#4c596d');
  }
  frames[face ? 'dungeon_wall_face' : 'dungeon_wall'] = t;
}
for (const open of [false, true]) {
  const t = new Img(16, 16); t.blit(frames.dungeon_wall_face, 0, 0);
  t.rect(3, 2, 10, 14, OUT); t.rect(5, 1, 6, 2, '#818a9b');
  t.rect(4, 4, 8, 12, open ? '#242b36' : '#936744');
  for (const x of [3, 11]) for (let y = 3; y < 16; y += 4) { t.rect(x, y, 2, 3, '#737e91'); t.px(x, y, '#929aae'); }
  if (open) {
    t.rect(5, 3, 6, 3, '#f0dca1'); t.hline(6, 3, 4, '#fff1bf');
    for (const x of [5, 10]) t.vline(x, 6, 10, '#b9905a');
    for (const y of [7, 10, 13]) t.hline(5, y, 6, '#dbb373');
  } else {
    for (const x of [6, 9]) t.vline(x, 4, 12, '#63472f');
    for (const y of [6, 12]) { t.hline(4, y, 8, '#323c4c'); t.px(5, y, '#a0a4a7'); t.px(10, y, '#a0a4a7'); }
    t.rect(9, 9, 2, 2, '#ebc154'); t.px(10, 10, OUT);
  }
  frames[`dungeon_door_${open ? 'open' : 'closed'}`] = t;
}
for (let v = 0; v < 3; v++) {
  const t = new Img(16, 16); t.rect(6, 8, 4, 6, '#34333e'); t.rect(7, 7, 2, 6, '#95613a');
  t.rect(5, 8, 6, 2, '#687081'); t.rect(6, 4, 4, 4, '#d56735');
  t.rect(7, 2 + v % 2, 2, 5, '#f1ae47'); t.px(6 + v, 1 + v, '#f1ae47');
  t.rect(7, 5, 2, 3, '#ffe9a2'); frames[`torch_${v}`] = t.outline();
}
{
  const t = new Img(16, 16); t.rect(3, 4, 5, 5, '#eebc35'); t.rect(4, 5, 3, 3, OUT);
  t.hline(4, 4, 3, '#fff0a0'); t.rect(7, 8, 5, 2, '#f4ce4b'); t.rect(10, 9, 2, 3, '#eebc35');
  t.px(8, 8, '#fff0a0'); frames.key = t.outline();
}
{
  const t = new Img(16, 16); t.hline(4, 8, 7, '#c9c8ba'); t.px(3, 7, '#dedccf'); t.px(3, 9, '#dedccf');
  t.px(11, 7, '#dedccf'); t.px(11, 9, '#dedccf'); t.rect(8, 3, 4, 3, '#c9c8ba'); t.px(9, 4, OUT); t.px(11, 4, OUT);
  frames.bones = t.outline();
}
{
  const t = new Img(16, 16);
  for (let i = 1; i < 13; i++) { t.px(1, i, '#8490a1'); t.px(i, 1, '#8490a1'); t.px(i, i, '#8490a1'); }
  for (let r = 4; r <= 12; r += 4) for (let x = 2; x < r; x++) t.px(x, r - x + 1, '#687589');
  frames.cobweb = t;
}
{
  const t = new Img(16, 16); t.ellipse(8, 10, 6, 3, '#273b51'); t.ellipse(8, 9, 5, 2, '#38556e');
  t.hline(5, 8, 4, '#6a8b9f'); t.px(11, 10, '#54768c'); frames.puddle = t;
}
{
  const t = new Img(16, 16);
  for (const [x, y, w, h] of [[3, 9, 4, 3], [8, 6, 4, 4], [10, 11, 3, 2]]) {
    t.rect(x, y, w, h, '#566377'); t.hline(x, y, w, '#798499'); t.px(x + w - 1, y + h - 1, '#354054');
  }
  frames.rubble = t.outline();
}
{
  const t = new Img(16, 16);
  for (const [x, y, c] of [[3, 9, '#a4753b'], [6, 11, '#89753e'], [9, 7, '#b68b48'], [11, 10, '#68714a'], [5, 6, '#867145']]) {
    t.rect(x, y, 3, 2, c); t.px(x + 1, y - 1, c); t.px(x + 1, y + 1, '#534a34');
  }
  frames.leaves = t.outline();
}
{
  const t = new Img(16, 16); t.blit(frames.grass_0, 0, 0);
  t.ellipse(8, 9, 6, 4, '#455331'); t.ellipse(8, 9, 5, 3, OUT); t.ellipse(8, 10, 4, 2, '#222731');
  t.hline(5, 6, 4, '#536c38'); t.px(3, 8, '#6f9e4a'); t.px(11, 7, '#6f9e4a');
  t.vline(5, 7, 3, '#9a7950'); t.px(6, 9, '#9a7950'); t.vline(11, 8, 2, '#785d3e'); frames.hole = t;
}
for (const open of [false, true]) {
  const t = new Img(16, 16); t.blit(frames.grass_0, 0, 0); t.rect(2, 4, 12, 10, OUT); t.rect(3, 5, 10, 8, '#242b31');
  if (open) {
    t.rect(2, 1, 12, 4, OUT); t.rect(3, 1, 10, 3, '#8c7352'); t.hline(3, 1, 10, '#b29b71');
    for (const x of [5, 10]) t.vline(x, 7, 6, '#a98455'); t.hline(5, 9, 6, '#c4a16a'); t.hline(5, 12, 6, '#c4a16a');
  } else {
    t.rect(3, 5, 10, 8, '#8c7352'); t.hline(3, 5, 10, '#b29b71');
    for (const x of [6, 10]) t.vline(x, 6, 7, '#665439');
    for (const y of [7, 11]) { t.hline(3, y, 10, '#4c5150'); t.px(4, y, '#989c8b'); }
    t.rect(10, 8, 2, 2, OUT); t.px(10, 8, '#b4ae91');
  }
  frames[open ? 'hatch_open' : 'hatch'] = t;
}

// ---------- effects: hats, auras, critters (drawn over/around a person by client/src/effects.ts) ----------
// Hats sit on the head: the bottom row lands on the character frame's row 4 (just above the brow).
{
  const hat = (name, w, h, draw) => { const t = new Img(w, h); draw(t); frames[`hat_${name}`] = t.outline(); };
  hat('top', 16, 11, t => { // classic black top hat, red band
    t.rect(4, 1, 8, 7, '#2a2430'); t.vline(5, 1, 7, '#3e3648'); t.rect(4, 6, 8, 2, '#b4473a');
    t.rect(1, 8, 14, 2, '#2a2430'); t.hline(2, 8, 12, '#3e3648');
  });
  hat('party', 16, 12, t => { // striped cone and a pompom
    for (let y = 2; y < 11; y++) { const half = Math.floor((y - 1) / 2); t.hline(8 - half, y, half * 2 + 1, y % 4 < 2 ? '#e8607a' : '#f2d060'); }
    t.ellipse(8, 1.5, 1.6, 1.6, '#7ad0e8');
  });
  hat('wizard', 16, 14, t => { // blue cone with a bent tip, stars, wide brim
    for (let y = 3; y < 12; y++) { const half = Math.floor((y - 2) / 2) + 1; t.hline(8 - half, y, half * 2, '#4a5ab0'); t.px(8 - half, y, '#3a4890'); }
    t.rect(9, 1, 2, 2, '#4a5ab0'); t.px(11, 0, '#4a5ab0');
    t.px(7, 6, '#f2d060'); t.px(9, 9, '#f2d060'); t.px(6, 10, '#e8e0d0');
    t.rect(1, 11, 14, 2, '#3a4890'); t.hline(2, 11, 12, '#5a6ac8');
  });
  hat('cowboy', 16, 8, t => { // brown crown with a dent, wide curled brim
    t.hline(4, 1, 3, '#8a5a30'); t.hline(9, 1, 3, '#8a5a30'); t.rect(4, 2, 8, 3, '#8a5a30'); t.hline(4, 4, 8, '#5a3a20');
    t.rect(1, 5, 14, 2, '#a06a3a'); t.px(0, 4, '#a06a3a'); t.px(15, 4, '#a06a3a'); t.hline(2, 6, 12, '#7a4a28');
  });
  hat('crown', 16, 8, t => { // gold crown with gems
    t.rect(3, 3, 10, 4, '#e8b830'); t.hline(3, 6, 10, '#b88a20');
    for (const x of [3, 7, 12]) t.vline(x, 1, 2, '#e8b830'); t.vline(8, 1, 2, '#e8b830');
    t.px(5, 4, '#d84a4a'); t.px(8, 4, '#4a8ad8'); t.px(11, 4, '#4ab86a'); t.hline(4, 3, 8, '#f8e070');
  });
  hat('judge', 16, 13, t => { // tall gold-and-purple top hat with a star: the hackathon judges'
    t.rect(4, 1, 8, 9, '#6a3a9a'); t.vline(5, 1, 9, '#8a5ac0'); t.rect(4, 7, 8, 2, '#e8b830');
    t.px(8, 3, '#f8e070'); t.hline(7, 4, 3, '#f8e070'); t.px(8, 5, '#f8e070'); t.px(7, 5, '#f8e070'); t.px(9, 5, '#f8e070');
    t.rect(1, 10, 14, 2, '#6a3a9a'); t.hline(2, 10, 12, '#e8b830');
  });
  hat('bat', 16, 9, t => { // black cap with little ears and wing flaps, glowing eyes
    t.rect(4, 3, 8, 5, '#2a2236'); t.hline(5, 2, 6, '#2a2236'); t.hline(5, 3, 6, '#3c3250');
    t.vline(5, 0, 2, '#2a2236'); t.vline(10, 0, 2, '#2a2236'); t.px(6, 1, '#2a2236'); t.px(9, 1, '#2a2236');
    t.hline(0, 5, 4, '#1e1828'); t.hline(1, 6, 3, '#1e1828'); t.px(0, 6, '#1e1828'); t.hline(12, 5, 4, '#1e1828'); t.hline(12, 6, 3, '#1e1828'); t.px(15, 6, '#1e1828');
    t.px(6, 5, '#f0d060'); t.px(9, 5, '#f0d060');
  });
  hat('admin', 16, 9, t => { // the sysadmin's dark cap with a green cursor: root@t1a
    t.rect(3, 2, 10, 5, '#2c3440'); t.hline(4, 2, 8, '#3e4858'); t.rect(2, 6, 13, 2, '#1e2630'); t.hline(3, 7, 11, '#141a22');
    t.px(6, 4, '#5af07a'); t.px(7, 4, '#5af07a'); t.px(8, 3, '#5af07a'); t.px(8, 5, '#5af07a'); t.hline(9, 5, 2, '#5af07a');
  });
  { // a hat stand in the Lobby: a pole with pegs and a couple of hats hanging
    const t = new Img(16, 16);
    t.rect(6, 1, 4, 14, '#7a5230'); t.vline(7, 1, 14, '#9a6a3e'); t.rect(3, 14, 10, 2, '#5a3a20'); t.hline(4, 14, 8, '#7a5230');
    t.hline(2, 3, 4, '#5a3a20'); t.hline(10, 5, 4, '#5a3a20'); t.hline(2, 8, 4, '#5a3a20');
    t.rect(1, 1, 4, 2, '#2a2430'); t.px(2, 0, '#2a2430'); t.px(3, 0, '#2a2430');
    t.rect(11, 3, 3, 2, '#e8607a'); t.px(12, 2, '#f2d060');
    t.rect(1, 6, 4, 2, '#8a5a30'); t.hline(2, 5, 2, '#8a5a30');
    frames.hat_stand = t.outline();
  }
  for (const n of [1, 2]) { // a twinkle: big plus, then a small one
    const t = new Img(5, 5), c = '#fff6c0';
    if (n === 1) { t.hline(0, 2, 5, c); t.vline(2, 0, 5, c); t.px(2, 2, '#ffffff'); }
    else { t.hline(1, 2, 3, c); t.vline(2, 1, 3, c); }
    frames[`sparkle_${n}`] = t;
  }
  for (const n of [1, 2]) { // a bat, wings up then down
    const t = new Img(9, 5), c = '#2a1e30';
    t.rect(3, 1, 3, 3, c); t.px(3, 0, c); t.px(5, 0, c); t.px(4, 2, '#d84a4a');
    if (n === 1) { t.hline(0, 0, 3, c); t.px(2, 1, c); t.hline(6, 0, 3, c); t.px(6, 1, c); }
    else { t.hline(0, 3, 3, c); t.px(2, 2, c); t.hline(6, 3, 3, c); t.px(6, 2, c); }
    frames[`bat_${n}`] = t;
  }
  for (const n of [1, 2, 3]) { // a flame tongue flickering
    const t = new Img(5, 8);
    const h = [7, 6, 8][n - 1], lean = [0, 1, -1][n - 1];
    for (let y = 8 - h; y < 8; y++) {
      const k = (y - (8 - h)) / h, half = Math.round(k * 2);
      const x0 = 2 + Math.round(lean * (1 - k)) - half;
      t.hline(x0, y, half * 2 + 1, k < 0.35 ? '#f8e070' : k < 0.7 ? '#f8a030' : '#d8482a');
    }
    frames[`flame_${n}`] = t;
  }
  for (const n of [1, 2]) { // a little unicorn trotting right; mirrored for left
    const t = new Img(13, 11), W = '#f8f4f8', S = '#d8cce0';
    t.rect(2, 4, 7, 4, W); t.hline(2, 7, 7, S);                       // body
    t.rect(8, 2, 3, 3, W); t.px(11, 3, W); t.px(11, 4, S);          // head + muzzle
    t.px(9, 3, '#2a1e30');                                          // eye
    t.px(10, 1, '#f2d060'); t.px(11, 0, '#f2d060');                 // horn
    const mane = ['#e8607a', '#f2a040', '#f2d060', '#6ac870', '#5a8ae8', '#9a6ac8'];
    mane.forEach((c, i) => t.px(7 - (i >> 1), 2 + (i & 1) + (i >> 2), c));
    mane.forEach((c, i) => t.px(1 - (i & 1), 4 + i % 3, c));        // tail
    const legs = n === 1 ? [[2, 8, 2], [4, 8, 1], [6, 8, 2], [8, 8, 1]] : [[2, 8, 1], [4, 8, 2], [6, 8, 1], [8, 8, 2]];
    for (const [x, y, h] of legs) t.vline(x, y, h, S);
    const img = t.outline();
    frames[`unicorn_r_${n}`] = img; frames[`unicorn_l_${n}`] = img.mirror();
  }
  { // vampire cape: drawn behind the body (or over the back when walking away)
    const t = new Img(14, 13);
    for (let y = 0; y < 13; y++) { const half = 5 + (y > 6 ? 1 : 0) + (y > 10 ? 1 : 0); t.hline(7 - half, y, half * 2, y < 2 ? '#1a1418' : '#8a1a2a'); }
    t.vline(1, 2, 9, '#5a0e1a'); t.vline(12, 2, 9, '#5a0e1a');
    frames.cape = t.outline('#140c10');
  }
}

// ---------- creatures (cat, dog, bat, the cleaner, a ghost) and cups left on tables; no shared random calls ----------
// Side views facing right; the engine mirrors them for left.
{
  const C = '#e0924a', CD = '#b86a2e', CL = '#f4c088', PINK = '#e8909a';
  const cat = (draw) => { const t = new Img(16, 12); draw(t); return t.outline(); };
  for (const f of [0, 1]) frames[`cat_walk_${f}`] = cat(t => {
    t.ellipse(7.5, 7, 5, 2.5, C); t.hline(4, 6, 6, CD);
    for (const [x, up] of [[4, f], [6, 1 - f], [9, f], [11, 1 - f]]) t.vline(x, 9, up ? 1 : 2, CD);
    t.ellipse(12.5, 4.5, 2.6, 2.3, C); t.px(11, 2, C); t.px(14, 2, C); t.px(11, 1, CD); t.px(14, 1, CD);
    t.px(13, 4, OUT); t.px(15, 5, PINK); t.px(12, 6, CL);
    t.vline(2, 3, 4, C); t.px(1, 2, CD); t.px(3, 7, C);
  });
  frames.cat_sit = cat(t => {
    t.ellipse(8, 7.5, 3.5, 3.5, C); t.ellipse(9, 8, 1.5, 2.5, CL); t.hline(4, 10, 8, CD);
    t.ellipse(9, 3.5, 2.6, 2.3, C); t.px(7, 1, C); t.px(11, 1, C); t.px(7, 0, CD); t.px(11, 0, CD);
    t.px(8, 3, OUT); t.px(10, 3, OUT); t.px(9, 4, PINK);
    t.hline(1, 10, 4, C); t.px(1, 9, CD);
  });
  frames.cat_nap = cat(t => {
    t.ellipse(7.5, 8.5, 5.5, 2.6, C); t.hline(3, 7, 8, CD);
    t.ellipse(12, 8.5, 2.4, 2, C); t.px(11, 6, C); t.px(13, 6, CD); t.hline(11, 8, 2, OUT);
    t.hline(3, 10, 8, CL);
  });
  const D = '#c89a64', DD = '#8a5e36', DL = '#ecc890';
  const dog = (draw) => { const t = new Img(16, 14); draw(t); return t.outline(); };
  for (const f of [0, 1]) frames[`dog_walk_${f}`] = dog(t => {
    t.ellipse(7, 8, 5.5, 3, D); t.ellipse(7, 9.5, 3.5, 1.2, DL);
    for (const [x, up] of [[3, f], [5, 1 - f], [9, f], [11, 1 - f]]) t.vline(x, 11, up ? 2 : 3, DD);
    t.ellipse(12.5, 5, 2.8, 2.6, D); t.rect(14, 6, 2, 2, DL); t.px(15, 6, OUT);
    t.rect(11, 3, 2, 4, DD); t.px(13, 4, OUT);
    t.vline(1, 4 + f, 4, D); t.px(1, 3 + f, DL);
    t.hline(9, 6, 3, '#d04848');
  });
  frames.dog_sit = dog(t => {
    t.ellipse(8, 9, 3.5, 4, D); t.ellipse(9, 9.5, 1.6, 3, DL); t.hline(4, 13, 9, DD);
    t.ellipse(9.5, 4, 2.8, 2.6, D); t.rect(11, 5, 2, 2, DL); t.px(12, 5, OUT);
    t.rect(7, 2, 2, 4, DD); t.px(10, 3, OUT); t.hline(7, 6, 4, '#d04848');
    t.hline(2, 12, 3, D); t.px(1, 11, D);
  });
  frames.dog_nap = dog(t => {
    t.ellipse(7.5, 10, 6, 3, D); t.hline(3, 12, 9, DL);
    t.ellipse(13, 10, 2.4, 2.2, D); t.rect(11, 8, 2, 4, DD); t.hline(13, 9, 2, OUT);
  });
  const B = '#4a3a5a', BD = '#2e2438', BW = '#6a5880';
  for (const f of [0, 1]) {
    const t = new Img(14, 8);
    t.ellipse(7, 4, 1.8, 2.2, B); t.px(6, 1, B); t.px(8, 1, B); t.px(6, 3, '#f0d060'); t.px(8, 3, '#f0d060');
    if (f === 0) for (const s of [-1, 1]) { t.hline(7 + s * 2, 3, 1, BW); t.hline(7 + s * 3, 2, 1, BW); t.hline(7 + s * 4, 1, 1, BW); t.hline(7 + s * 5, 2, 1, BD); t.px(7 + s * 4, 2, BW); t.px(7 + s * 3, 3, BW); }
    else for (const s of [-1, 1]) { t.hline(7 + s * 2, 4, 1, BW); t.px(7 + s * 3, 5, BW); t.px(7 + s * 4, 5, BW); t.px(7 + s * 5, 6, BD); t.px(7 + s * 3, 4, BW); t.px(7 + s * 4, 4, BD); }
    frames[`bat_fly_${f}`] = t.outline();
  }
  {
    const t = new Img(8, 10); // hanging upside down, wings folded
    t.vline(4, 0, 2, BD); t.ellipse(4, 5, 2.4, 3.2, B); t.vline(2, 3, 4, BD); t.vline(6, 3, 4, BD);
    t.px(3, 7, '#f0d060'); t.px(5, 7, '#f0d060'); t.px(3, 9, B); t.px(5, 9, B);
    frames.bat_hang = t.outline();
  }
  // the cleaner: headscarf, blue smock, white apron, a mop
  const SK = '#e8b890', SC = '#c8484a', SM = '#4a6aa0', SMD = '#36507e', AP = '#f0ece0';
  const cleaner = (legs, wipe) => {
    const t = new Img(18, 24);
    t.vline(14 + wipe, 6, 17, '#8a6a40'); t.rect(12 + wipe, 21, 5, 2, '#d8d0b8');
    t.rect(5, 9, 7, 9, SM); t.vline(5, 9, 9, SMD); t.rect(6, 11, 5, 7, AP); t.hline(6, 11, 5, '#d8d0c0');
    t.rect(5, 18, 7, 2, SMD);
    for (const [x, d] of [[6, legs], [9, 1 - legs]]) t.rect(x, 20, 2, 3 - d, SK), t.rect(x, 23 - d, 2, 1, '#3a2a2a');
    t.ellipse(8.5, 5.5, 3.2, 3.4, SK); t.px(10, 5, OUT); t.px(11, 7, '#d89878');
    t.ellipse(8, 3.5, 3.6, 2.4, SC); t.rect(5, 3, 2, 5, SC); t.px(4, 8, SC); t.px(9, 1, '#e86a6a');
    t.rect(11, 10, 2, 4 - wipe, SM); t.rect(12 + wipe, 13 - wipe, 2, 2, SK);
    return t.outline();
  };
  frames.cleaner_0 = cleaner(0, 0); frames.cleaner_1 = cleaner(1, 0);
  frames.cleaner_clean_0 = cleaner(0, 1); frames.cleaner_clean_1 = cleaner(0, 2);
  // the ghost of Mazurkevich, the old office manager: a sheet, a moustache, a little clipboard
  for (const f of [0, 1]) {
    const t = new Img(16, 22), G = '#eef2ff', GS = '#c8d0ea';
    t.ellipse(8, 7, 6, 6, G); t.rect(2, 7, 12, 11, G); t.vline(2, 8, 10, GS);
    for (let x = 2; x < 14; x++) if ((x + f) % 4 < 2) t.rect(x, 18, 1, 2, G); else t.px(x, 18, GS);
    t.rect(5, 6, 2, 3, '#2a2a3a'); t.rect(9, 6, 2, 3, '#2a2a3a');
    t.hline(5, 10, 6, '#6a5040'); t.px(4, 11, '#6a5040'); t.px(11, 11, '#6a5040');
    t.rect(11, 12, 4, 5, '#c8a070'); t.hline(12, 14, 2, '#6a6a7a'); t.hline(12, 15, 2, '#6a6a7a');
    frames[`ghost_${f}`] = t.outline('#8a90b8');
  }
  { // a little heart that floats up when a pet is petted
    const t = new Img(7, 6), R = '#e8506a';
    t.hline(1, 0, 2, R); t.hline(4, 0, 2, R); t.hline(0, 1, 7, R); t.hline(0, 2, 7, R); t.hline(1, 3, 5, R); t.hline(2, 4, 3, R); t.px(3, 5, R); t.px(1, 1, '#f8a0b0');
    frames.heart = t.outline();
  }
  // cups on a table
  for (const [k, c] of [['coffee', '#5a3420'], ['tea', '#b88a3a']]) {
    const t = new Img(6, 6);
    t.rect(0, 1, 4, 4, '#f4f0e8'); t.hline(0, 1, 4, c); t.px(4, 2, '#f4f0e8'); t.px(5, 3, '#f4f0e8'); t.px(4, 4, '#f4f0e8'); t.hline(0, 5, 4, '#c8c0b0');
    frames[`cup_${k}`] = t.outline();
  }
}

// ---------- the Admin room and Berghain (no shared random calls: existing art stays unchanged) ----------
for (let v = 0; v < 3; v++) { // raised server-room floor: grey panels with perforations
  const t = new Img(16, 16);
  t.rect(0, 0, 16, 16, '#8f98a3'); t.hline(0, 0, 16, '#a9b1bb'); t.vline(0, 0, 16, '#a9b1bb'); t.hline(0, 15, 16, '#6f7782'); t.vline(15, 0, 16, '#6f7782');
  for (let y = 4; y < 13; y += 4) for (let x = 4; x < 13; x += 4) if ((x + y + v * 4) % 12) t.px(x, y, '#737b86');
  if (v === 2) { t.rect(6, 6, 4, 4, '#7d8590'); t.hline(6, 6, 4, '#b8c0c9'); }
  frames[`raised_${v}`] = t;
}
for (let v = 0; v < 3; v++) { // the club's floor: near-black concrete
  const t = new Img(16, 16);
  t.rect(0, 0, 16, 16, '#1d1922'); t.hline(0, 15, 16, '#15121a'); t.vline(15, 0, 16, '#15121a');
  for (const [x, y] of [[3 + v * 4, 4], [11 - v * 3, 10], [6, 13 - v * 2]]) t.px(x, y, '#2b2533');
  if (v === 1) t.px(9, 6, '#3c3247');
  frames[`club_${v}`] = t;
}
for (const blink of [0, 1]) { // a rack of servers, LEDs blinking
  const t = new Img(16, 32);
  t.rect(1, 3, 14, 28, '#2a2d36'); t.hline(1, 3, 14, '#4a4f5c'); t.rect(2, 5, 12, 24, '#1a1c22');
  for (let i = 0; i < 6; i++) {
    const y = 6 + i * 4;
    t.rect(3, y, 10, 3, '#3a3e4a'); t.hline(3, y, 10, '#505665');
    t.px(4, y + 1, (i + blink) % 3 ? '#7cd87c' : '#2f5a2f'); t.px(6, y + 1, (i * 2 + blink) % 4 ? '#e8b860' : '#6a5328');
    for (let x = 8; x < 12; x++) t.px(x, y + 1, '#262931');
  }
  t.rect(2, 30, 3, 1, OUT); t.rect(11, 30, 3, 1, OUT);
  frames[blink ? 'server_rack_1' : 'server_rack'] = t.outline();
}
{
  const t = new Img(32, 16); // pink and cyan neon on a dark plate
  t.rect(1, 2, 30, 12, '#211a2b');
  t.rect(3, 4, 26, 1, '#ff5ec8'); t.rect(3, 11, 26, 1, '#ff5ec8'); t.vline(3, 4, 8, '#ff5ec8'); t.vline(28, 4, 8, '#ff5ec8');
  for (let x = 6; x < 26; x++) t.px(x, 7 + Math.abs(((x - 6) % 6) - 3) - 1, '#5ef0ff');
  frames.neon_sign = t.outline();
}
{
  const t = new Img(48, 24); // DJ booth: two decks and a mixer
  t.rect(1, 9, 46, 14, '#16131c'); t.rect(1, 8, 46, 3, '#3a3346'); t.hline(1, 8, 46, '#5a5068');
  t.hline(2, 15, 44, '#ff5ec8'); t.hline(2, 18, 44, '#5ef0ff');
  for (const cx of [10, 38]) { t.ellipse(cx, 6, 6, 3.5, '#2a2a30'); t.ellipse(cx, 6, 4, 2.4, '#111015'); t.px(cx, 6, '#e8dcc8'); t.hline(cx + 3, 3, 3, '#a0a4ae'); }
  t.rect(20, 3, 8, 5, '#2f2c38'); for (const x of [21, 23, 25]) t.vline(x, 4, 3, '#a0a4ae'); t.px(26, 4, '#7cd87c');
  frames.dj_booth = t.outline();
}
{
  const t = new Img(16, 24); // the bouncer: arms folded, shades on
  t.rect(3, 9, 10, 12, '#34343f'); t.rect(2, 11, 12, 6, '#34343f'); t.vline(2, 11, 6, '#565666'); t.vline(13, 11, 6, '#565666');
  t.rect(7, 9, 2, 3, '#e8e6ee'); // shirt collar
  t.rect(3, 13, 10, 3, '#454552'); t.hline(3, 13, 10, '#646475'); // folded arms
  t.rect(5, 1, 6, 7, '#c89474'); t.hline(5, 1, 6, '#d8a888'); t.rect(5, 4, 6, 1, '#111'); t.px(8, 4, '#3a3a40');
  t.rect(6, 7, 4, 1, '#a87454'); t.rect(7, 8, 2, 1, '#1a1a1f');
  t.rect(4, 21, 3, 2, '#111'); t.rect(9, 21, 3, 2, '#111'); t.rect(4, 20, 8, 1, '#2a2a30');
  t.px(12, 10, '#e8b860'); // earpiece
  frames.bouncer = t.outline();
}
const stall = (state) => { // a roomy stall for up to four: free (door open), busy (half door shut), full (overflowing, taped off)
  const t = new Img(32, 32);
  t.rect(0, 0, 32, 32, '#3a3346'); t.rect(2, 2, 28, 29, '#2a2433'); // partitions and back wall
  t.vline(0, 0, 32, '#6d6080'); t.vline(31, 0, 32, '#6d6080'); t.hline(0, 0, 32, '#8a7aa0');
  t.rect(5, 4, 8, 6, '#e8e6ee'); t.hline(5, 4, 8, '#ffffff'); t.px(11, 5, '#a0a4ae'); // tank
  t.ellipse(9, 17, 5, 4, '#e8e6ee'); t.ellipse(9, 17, 3, 2.4, state === 'full' ? '#7a5a2e' : '#7ab8d8'); t.rect(7, 20, 5, 6, '#d8d6de');
  t.rect(17, 6, 12, 4, '#a8825a'); t.hline(17, 6, 12, '#c49c70'); t.hline(17, 10, 12, '#6a4a32'); // the little shelf
  t.px(18, 11, '#6a4a32'); t.px(27, 11, '#6a4a32');
  if (state === 'free') { t.rect(2, 16, 3, 15, '#6b4a8a'); t.vline(4, 16, 15, '#8a64b0'); } // door swung open
  if (state === 'busy') {
    t.rect(2, 16, 28, 15, '#6b4a8a'); t.hline(2, 16, 28, '#8a64b0'); t.vline(16, 17, 14, '#5a3c76');
    t.rect(25, 22, 3, 2, '#d84a4a'); t.px(14, 24, '#e8b860'); t.px(18, 24, '#e8b860');
  }
  if (state === 'full') {
    t.ellipse(14, 28, 13, 3, '#8a6a3a'); t.ellipse(14, 28, 10, 2, '#a07e4a'); t.ellipse(5, 24, 3, 1.5, '#8a6a3a');
    for (let i = 0; i < 32; i++) { const c = i % 4 < 2 ? '#e8c840' : '#1a1a1f'; t.px(i, 8 + (i >> 1), c); t.px(i, 23 - (i >> 1), c); } // tape across
    t.px(9, 2, '#111'); t.px(20, 3, '#111'); t.px(24, 1, '#111'); // flies
  }
  return t.outline();
};
frames.toilet = stall('free'); frames.toilet_busy = stall('busy'); frames.toilet_full = stall('full');
for (const axis of ['h', 'v']) { // a room door only admins open: the closed door with a red light and a padlock
  const c = frames[`door_${axis}_closed`], t = new Img(c.w, c.h); t.blit(c, 0, 0);
  t.rect(c.w / 2 - 3, 20, 6, 5, '#e8b860'); t.rect(c.w / 2 - 2, 17, 4, 3, OUT); t.rect(c.w / 2 - 1, 18, 2, 2, [0, 0, 0, 0]);
  t.px(c.w / 2, 22, OUT); t.rect(c.w / 2 - 2, 9, 4, 2, '#e84a4a');
  frames[`door_${axis}_locked`] = t;
}

// ---------- pack world atlas (shelf packer) ----------
const names = Object.keys(frames).sort((a, b) => frames[b].h - frames[a].h || frames[b].w - frames[a].w);
const AW = 256; let x = 0, y = 0, rowH = 0; const rects = {};
for (const n of names) {
  const f = frames[n];
  if (x + f.w > AW) { x = 0; y += rowH + 1; rowH = 0; }
  rects[n] = { x, y, w: f.w, h: f.h }; x += f.w + 1; rowH = Math.max(rowH, f.h);
}
const world = new Img(AW, y + rowH);
for (const n of names) world.blit(frames[n], rects[n].x, rects[n].y);

const out = new URL('../client/public/assets/', import.meta.url);
writeFileSync(new URL('world.png', out), png(world));
writeFileSync(new URL('characters.png', out), png(chars));
writeFileSync(new URL('accessories.png', out), png(accessories));
writeFileSync(new URL('atlas.json', out), JSON.stringify({
  name: 'deck-procedural-v1', license: 'CC0', image: 'world.png', tileSize: 16, frames: rects,
  character: { image: 'characters.png', frameW: CW, frameH: CH, framesPerDir: FPD, dirs: DIRS, styles: STYLES, tops: TOPS, bottoms: BOTTOMS, keys: K,
    accessories: { image: 'accessories.png', frameW: CW, frameH: CH, items: ACCESSORY_ITEMS, keys: ACCESSORY_KEYS } },
}, null, 1));
console.log(`atlas: ${names.length} frames, world ${AW}x${world.h}, characters ${chars.w}x${chars.h}, accessories ${accessories.w}x${accessories.h}`);
