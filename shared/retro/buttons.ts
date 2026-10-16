export const RIGHT = 1, LEFT = 2, UP = 4, DOWN = 8, A = 16, B = 32, SELECT = 64, START = 128;
export function normalize(bits: number): number {
  bits &= 255;
  if ((bits & 3) === 3) bits &= ~3;
  if ((bits & 12) === 12) bits &= ~12;
  return bits;
}
