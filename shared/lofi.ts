export const LOFI_CHANNEL = 'https://www.youtube.com/@LofiGirl/streams';
export interface LofiStream { videoId: string; title: string }
export interface LofiLiveReply {
  status: 'live' | 'offline' | 'unavailable';
  stream: LofiStream | null;
  checkedAt: number | null;
}
export function unavailableLofi(previous: LofiLiveReply | null, now: number): LofiLiveReply {
  const checkedAt = previous?.checkedAt ?? null;
  const freshEnough = checkedAt !== null && now - checkedAt < 30 * 60_000;
  return { status: 'unavailable', stream: freshEnough ? previous?.stream ?? null : null, checkedAt };
}
