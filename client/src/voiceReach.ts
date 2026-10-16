/** Which peers of a call can't be reached, from each connection's state and how long it has been in it. Pure, so testable. */
export type PeerReach = { id: string; state: RTCPeerConnectionState | undefined; since: number };

/** A fresh 'new'/'connecting' is a normal join; only after this long does it count as unreachable. */
export const REACH_GRACE_MS = 8_000;
export const REACH_TITLE = 'They may be on a strict network; the relay is being tried';

export function unreachablePeers(peers: PeerReach[], now: number, grace = REACH_GRACE_MS) {
  return peers.filter(p => {
    if (p.state === 'connected') return false;
    if (p.state === 'new' || p.state === 'connecting') return now - p.since > grace;
    return true; // disconnected, failed, closed, or no connection yet
  }).map(p => p.id);
}

/** "Can't reach Kim" / "Can't reach Kim, Ana"; '' when everyone is reachable. */
export function reachLabel(names: string[]) {
  return names.length ? `Can't reach ${names.map(n => n.split(' ')[0]).join(', ')}` : '';
}
