// Shared by the map and art generators: surfaces and stairs must agree with collision.
const terraces = new Map([
  [34, [13, 19]], [35, [11, 20]], [36, [8, 21]],
  [38, [6, 22]], [39, [5, 23]], [41, [3, 24]], [42, [2, 23]],
]);
export const mountainFloor = (x, y) => {
  if ((x === 8 && y === 37) || (x === 22 && y === 40)) return 'stairs';
  if (y === 43 && [4, 10, 16, 20].includes(x)) return 'terrace';
  const span = terraces.get(y);
  if (!span || x < span[0] || x > span[1]) {
    // A grassy valley outlines the rising massif. A solid cliff rim separates
    // it from every shelf, so the only entrances remain the foot and stairs.
    const edge = [11, 8, 7, 4, 4, 4, 2, 2, 2, 2][y - 34];
    if (x < edge || (y <= 35 && x >= 22) || (y === 36 && x >= 23)) return 'valley';
    return null;
  }
  return y <= 35 && x >= 16 && x <= 18 ? 'snow' : 'terrace';
};
export const mountainLevel = y => y <= 37 ? 3 : y <= 40 ? 2 : 1;
