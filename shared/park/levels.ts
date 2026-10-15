import { parseLevel, type LevelDef, type LevelMeta } from './sim';

// Stamp short runs into the same twelve-row ASCII format used by the replay tool.
function level(id: number, name: string, width: number, runs: [number, number, string][], meta: Omit<LevelMeta, 'id' | 'name' | 'rows'> = {}): LevelDef {
  const rows: string[][] = Array.from({ length: 12 }, (_, y) => Array.from({ length: width }, () => y === 11 ? '#' : '.'));
  for (const [x, y, run] of runs) {
    if (x < 0 || x + run.length > width || y < 0 || y > 11) throw new Error(`stamp outside level ${id}`);
    for (let i = 0; i < run.length; i++) rows[y][x + i] = run[i];
  }
  return parseLevel({ id, name, rows: rows.map(r => r.join('')), ...meta });
}
export const LEVELS: LevelDef[] = [
  level(0, 'Lobby', 20, [[1, 10, 'S']], {
    lobby: { start: { x: 8, y: 11, w: 4, h: 1 }, selectors: [
      { x: 5, y: 7, w: 2, h: 1, delta: -1 }, { x: 13, y: 7, w: 2, h: 1, delta: 1 },
    ] },
  }),
  // The booster can walk under the key shelf; nobody is stranded by the stack.
  level(1, 'First Steps', 46, [
    [1, 10, 'S'], [6, 10, 'BBBBBB'], [9, 9, 'BBB'], [12, 11, '..'],
    [7, 8, 'C'], [10, 7, 'C'], [12, 7, 'C'], [14, 8, 'C'], [17, 10, 'BB'],
    [20, 10, 's'], [21, 9, 's'], [23, 8, 'BBBBB'], [25, 7, 'K'], [23, 6, 'C'], [27, 6, 'C'],
    [31, 9, '=='], [31, 7, 'C'], [35, 11, '..'], [35, 8, 'C'], [39, 10, 'BBBBB'], [41, 8, 'C'], [43, 9, 'D'],
  ]),
  level(2, 'Heavy Lifting', 56, [
    [1, 10, 'S'], [7, 10, 'X'], [11, 8, 'BBBBBBBB'], [11, 9, 'BBBBBBBB'], [11, 10, 'BBBBBBBB'],
    [7, 7, 'C'], [11, 6, 'C'], [15, 6, 'C'], [19, 7, 'C'], [22, 10, 'F'],
    [25, 10, 'X'], [29, 10, '1'], [30, 10, 'B'],
    ...Array.from({ length: 11 }, (_, y): [number, number, string] => [34, y, 'a']),
    [38, 10, 'BBBB'], [39, 9, 'K'], [38, 7, 'C'], [41, 7, 'C'], [44, 11, '..'], [45, 8, 'C'],
    [48, 9, '=='], [49, 7, 'C'], [52, 10, 'BBB'], [53, 9, 'D'],
  ], { boxes: [{ need: 'all' }, { need: 'all' }], buttons: { '1': { need: 1 } } }),
  level(3, 'Going Up', 56, [
    [1, 10, 'S'], [6, 10, 'E'], [9, 9, 'C'], [12, 10, 'BB'], [12, 8, 'C'], [16, 11, '..'], [17, 8, 'C'],
    [27, 4, 'F'], [20, 10, 'L'], [23, 5, 'BBBBBBBBBBBBBB'], [25, 3, 'C'], [28, 3, 'C'], [28, 4, 'B'], [30, 4, 'K'], [33, 4, 'E'], [35, 4, 'B'], [35, 3, 'C'],
    [39, 9, '=='], [39, 7, 'C'], [43, 10, 'BB'], [44, 8, 'C'], [47, 11, '..'], [48, 8, 'C'], [52, 10, 'BB'], [53, 9, 'D'],
  ], { lifts: [{ need: 'all', dy: -5, speed: 1 }] }),
  level(4, 'Hold the Door', 60, [
    [1, 10, 'S'], [5, 10, 'BB'], [6, 8, 'C'], [9, 11, '..'], [10, 8, 'C'], [13, 10, '1'],
    ...Array.from({ length: 11 }, (_, y): [number, number, string] => [17, y, 'a']),
    [20, 10, '1'], [23, 9, '=='], [23, 7, 'C'], [27, 10, 'F'],
    [30, 10, 's'], [31, 9, 's'], [33, 8, 'BBBB'], [34, 7, '2'], [39, 9, 'B'], [40, 10, 'B'], [33, 6, 'C'], [36, 6, 'C'],
    ...Array.from({ length: 11 }, (_, y): [number, number, string] => [42, y, 'b']),
    [39, 7, 'C'], [46, 10, 'BBB'], [47, 9, 'K'], [47, 7, 'C'], [51, 11, '..'], [52, 8, 'C'], [55, 10, 'BBB'], [57, 9, 'D'],
  ], { buttons: { '1': { need: 1, latchSolo: true }, '2': { need: 2, latch: true } } }),
  level(5, 'Human Tower', 60, [
    [1, 10, 'S'], [5, 10, 'BB'], [6, 8, 'C'], [9, 11, '..'], [10, 8, 'C'],
    [11, 10, 's'], [12, 9, 's'], [14, 8, 'BBBBBB'], [17, 7, '1'], [15, 6, 'C'], [19, 6, 'C'], [19, 9, 'a'], [19, 10, 'a'],
    [23, 10, 'F'], [26, 10, 's'], [27, 9, 's'], [28, 8, 'ssttt'], [31, 7, 'ss'], [29, 6, 'C'], [32, 6, 'C'],
    [34, 6, 'BBBBBBBB'], [37, 5, 'K'], [35, 4, 'C'], [40, 4, 'C'],
    [44, 9, '=='], [45, 7, 'C'], [45, 10, 'F'], [49, 11, '..'], [50, 8, 'C'], [54, 10, 'BBBB'], [57, 9, 'D'],
  ], { buttons: { '1': { need: 1, latch: true } } }),
  level(6, 'Spike Garden', 70, [
    [1, 10, 'S'], [5, 10, 'BB'], [6, 8, 'C'], [9, 10, 'F'], [10, 10, 'BBB'],
    [13, 10, '^^^^^^^^^^'], [12, 9, 'M'], [16, 6, 'C'], [20, 6, 'C'], [24, 10, 'BB'], [25, 8, 'C'],
    [28, 9, '==='], [29, 7, 'C'], [39, 5, 'F'], [35, 10, '^^^^^^^^'], [35, 9, 'M'],
    [39, 6, '==='], [40, 4, 'C'], [43, 8, '==='], [44, 6, 'C'], [47, 10, 'BB'], [48, 8, 'C'],
    [54, 9, '=='], [55, 7, 'C'], [58, 10, 'BB'], [59, 9, 'K'], [62, 11, '..'], [63, 8, 'C'], [66, 10, 'BBB'], [68, 9, 'D'],
  ], { movers: [{ dx: 8, dy: 0, period: 360 }, { dx: 0, dy: -4, period: 240 }] }),
  // Upper button -> key chamber -> lower button; the holder drops forward onto the exit route.
  level(7, 'Key Relay', 70, [
    [1, 10, 'S'], [5, 10, 'BB'], [6, 8, 'C'], [9, 11, '..'], [10, 8, 'C'], [13, 9, '=='], [14, 7, 'C'],
    [18, 10, 'F'], [20, 10, 'BB'], [22, 9, 'BB'], [24, 8, 'BBBBBBBB'], [26, 7, '1'], [24, 6, 'C'], [29, 6, 'C'],
    ...Array.from({ length: 11 }, (_, y): [number, number, string] => [37, y, 'a']),
    [40, 9, 'C'], [43, 10, '1'], [44, 9, 'K'], [44, 10, 'BBB'], [46, 7, 'C'], [49, 10, 'F'],
    [52, 9, '=='], [53, 7, 'C'], [56, 11, '..'], [57, 8, 'C'], [60, 10, 'BB'], [61, 8, 'C'], [66, 10, 'BBB'], [68, 9, 'D'],
  ], { buttons: { '1': { need: 1, latchSolo: true } } }),
  level(8, 'Grand Finale', 96, [
    [1, 10, 'S'], [6, 10, 'X'], [10, 8, 'BBBBBB'], [10, 9, 'BBBBBB'], [10, 10, 'BBBBBB'], [7, 7, 'C'], [12, 6, 'C'],
    [32, 10, 'F'], [21, 10, 'L'], [24, 6, 'BBBBBBBB'], [26, 4, 'C'], [30, 4, 'C'],
    [34, 10, '1'], ...Array.from({ length: 11 }, (_, y): [number, number, string] => [38, y, 'a']), [41, 10, '1'], [44, 9, 'C'],
    [48, 10, 'BBB'], [51, 10, '^^^^^^^^'], [50, 9, 'M'], [54, 6, 'C'], [58, 6, 'C'], [60, 10, 'BB'],
    [63, 10, 'F'], [65, 10, 's'], [66, 9, 's'], [68, 8, 'BBBBBB'], [71, 7, 'K'], [68, 6, 'C'], [73, 6, 'C'],
    [77, 10, 'BBEBBBB'], [80, 8, 'C'], [85, 11, '..'], [86, 8, 'C'], [91, 10, 'BBBB'], [93, 9, 'D'],
  ], { boxes: [{ need: 'all' }], lifts: [{ need: 'all', dy: -4, speed: 1 }],
    buttons: { '1': { need: 1, latchSolo: true } }, movers: [{ dx: 6, dy: 0, period: 300 }] }),
];
