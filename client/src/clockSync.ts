/** NTP-style clock sync over the WebSocket: each ping's round trip brackets the server's reading of its clock. The reading
 *  with the shortest round trip is the best (the least room for uneven one-way delays), so the offset is taken from it. */
export type ClockSample = { rtt: number; offset: number };
export const CLOCK_SAMPLES = 12;
/** sentAt: Date.now() when the ping left; rtt: the round trip measured on a monotonic clock */
export function clockSample(sentAt: number, rtt: number, serverTime: number): ClockSample | null {
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > 10_000 || !Number.isFinite(serverTime)) return null;
  return { rtt, offset: serverTime - (sentAt + rtt / 2) };
}
export function bestOffset(samples: ClockSample[]): number | null {
  let best: ClockSample | null = null;
  for (const s of samples.slice(-CLOCK_SAMPLES)) if (!best || s.rtt < best.rtt) best = s;
  return best ? best.offset : null;
}
