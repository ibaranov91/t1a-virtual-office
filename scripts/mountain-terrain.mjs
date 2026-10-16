// Collision and continuous world-pixel art share this mountain definition.
const spans = [[12, 13], [10, 15], [8, 17], [6, 19], [4, 21], [3, 22]];
export const mountainFloor = (x, y) => {
  if (x < 1 || x > 24 || y < 34 || y > 39) return null;
  if (y === 34 && (x === 12 || x === 13)) return 'snow';
  if (y === 38 && x >= 9 && x <= 21 || x === 9 && y === 37 ||
      y === 36 && x >= 9 && x <= 13 || x === 13 && y === 35) return 'trail';
  const [lo, hi] = spans[y - 34];
  return y >= 36 && (x < lo || x > hi) ? 'meadow' : null;
};

const apexX = 13 * 16, apexY = 34 * 16, baseY = 40 * 16;
// Pixel centres sample the straight diagonals down to row 39's bottom edge.
export const mountainEdges = py => {
  const depth = (py - apexY) / (baseY - apexY);
  return [apexX + (3 * 16 - apexX) * depth, apexX + (23 * 16 - apexX) * depth];
};
const grain = (x, y, seed = 131) => ((x * 73856093 ^ y * 19349663 ^ seed * 83492791) >>> 0);
const mix = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f)).concat(255);
const meadow = (x, y) => {
  const h = grain(x, y);
  if (h % 293 === 0) return '#efdf9c';
  if (h % 307 === 0) return '#e8cdd9';
  return h % 19 === 0 ? '#94b86a' : h % 31 === 0 ? '#6a8d4d' : '#7fa35c';
};
const backdrop = (x, y) => {
  for (const [cx, top, half] of [[64, 548, 60], [184, 550, 73], [318, 546, 68]]) {
    const slope = Math.abs(x - cx) / half, depth = (y - top) / 28;
    if (depth >= slope) return depth < slope + .18 ? '#dfe8ee' : '#9fb2c2';
  }
  return '#b8c9ce';
};
// Semicircles round the switchbacks through tiles (9,37) and (13,35).
const trailLegs = [[168, 616, 360, 616], [168, 584, 200, 584], [200, 552, 208, 552]];
const trailDistance = (x, y) => {
  let distance = Infinity;
  for (const [ax, ay, bx, by] of trailLegs) {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    distance = Math.min(distance, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
  }
  for (const [cx, cy, side] of [[168, 600, -1], [200, 568, 1]]) {
    if ((x - cx) * side >= 0) distance = Math.min(distance, Math.abs(Math.hypot(x - cx, y - cy) - 16));
    else distance = Math.min(distance, Math.hypot(x - cx, y - cy - 16), Math.hypot(x - cx, y - cy + 16));
  }
  return distance;
};
export const mountainPixel = (px, py) => {
  const [left, right] = mountainEdges(py + .5), x = px + .5, y = py + .5;
  const outside = py < 36 * 16 ? backdrop(px, py) : meadow(px, py);
  const ridge = apexX + (py - apexY) * .08;
  const depth = Math.max(0, Math.min(1, (py - apexY) / (6 * 16)));
  const h = grain(px, py), onFace = x >= left && x <= right;
  let color = outside;
  if (onFace) {
    color = x < ridge ? mix([169, 178, 180], [143, 154, 160], depth) : mix([111, 122, 131], [88, 98, 107], depth);
    if (Math.abs(x - ridge) < 1.3) color = '#b4bfc1';
    if ((py + Math.floor(px / 37) * 2) % 23 === 0 && px % 37 < 24) color = x < ridge ? '#839095' : '#505d67';
    if ((px + Math.floor(py / 3)) % 53 === 0 && py % 21 < 9) color = '#56626a';
    if (py >= baseY - 5) {
      color = '#58626b';
      if (h % 7 < 2) color = h % 2 ? '#6f8f55' : '#8fae67';
    }
    const surface = mountainFloor(Math.floor(px / 16), Math.floor(py / 16));
    const distance = trailDistance(x, y);
    if (surface === 'trail' && distance <= 8) {
      color = '#c8b08a';
      if (distance > 6.5 && h % 5 === 0) color = '#8f8170';
    } else if (trailDistance(x, y + 2) <= 8 && distance > 8) color = '#505d67';
    const snowEdge = apexY + 21 + (grain(Math.floor(px / 5), 0, 7) % 6) + Math.max(0, 13 - Math.abs(x - ridge) * 2);
    if (py < snowEdge) color = x < ridge ? '#f2f6f5' : '#c9d7de';
    // Paint the outline last so snow and trail cannot erase either diagonal.
    if (x - left < 5 / 3 || right - x < 5 / 3) color = '#505e65';
  }
  return color;
};
