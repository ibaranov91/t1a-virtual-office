import { LOFI_CHANNEL, unavailableLofi, type LofiLiveReply, type LofiStream } from '../../shared/lofi';
const CHANNEL_ID = 'UCSJ4gkVC6NrvII8umztf0Ow';
const REFRESH_MS = 5 * 60_000, RETRY_MS = 60_000;
const field = (value: unknown, ...path: string[]): unknown => {
  for (const key of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
};
function* nodes(value: unknown): Generator<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) yield value as Record<string, unknown>;
  for (const child of Object.values(value)) yield* nodes(child);
}
export function parseLofiLive(html: string): LofiStream | null {
  const match = html.match(/(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=)\s*(\{.*?\});\s*<\/script>/s);
  if (!match) throw new Error('YouTube channel data missing');
  const data: unknown = JSON.parse(match[1]);
  if (field(data, 'metadata', 'channelMetadataRenderer', 'externalId') !== CHANNEL_ID) throw new Error('Unexpected YouTube channel');
  const tabs = field(data, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs');
  const content = Array.isArray(tabs) && tabs.find(tab => field(tab, 'tabRenderer', 'selected') === true);
  const root = field(content, 'tabRenderer', 'content');
  if (!root || ![...nodes(root)].some(n => n.richGridRenderer || n.sectionListRenderer)) throw new Error('YouTube streams layout changed');
  for (const node of nodes(root)) {
    const modern = node.lockupViewModel, legacy = node.videoRenderer, item = modern ?? legacy;
    if (!item) continue;
    const videoId = modern ? field(item, 'contentId') : field(item, 'videoId');
    const runs = field(item, 'title', 'runs');
    const title = modern ? field(item, 'metadata', 'lockupMetadataViewModel', 'title', 'content') :
      field(item, 'title', 'simpleText') ?? (Array.isArray(runs) ? runs.map(r => field(r, 'text')).join('') : '');
    const live = [...nodes(item)].some(n => n.badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' || n.style === 'LIVE' || n.style === 'BADGE_STYLE_TYPE_LIVE_NOW');
    if (live && typeof videoId === 'string' && /^[\w-]{11}$/.test(videoId) && typeof title === 'string' &&
      /^lofi hip hop radio\b/i.test(title) && /relax\/study/i.test(title)) return { videoId, title };
  }
  return null;
}
async function readChannel(): Promise<string> {
  const response = await fetch(`${LOFI_CHANNEL}?hl=en`, { signal: AbortSignal.timeout(10_000), headers: { 'accept-language': 'en', 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok || !response.body) throw new Error(`YouTube HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 3 * 1024 * 1024) { await reader.cancel(); throw new Error('YouTube page too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export class LofiLive {
  private result: LofiLiveReply = { status: 'unavailable', stream: null, checkedAt: null };
  private expires = 0;
  private pending?: Promise<LofiLiveReply>;
  constructor(private read: () => Promise<string> = readChannel, private now = Date.now) {}
  async get(): Promise<LofiLiveReply> {
    if (this.now() < this.expires) return this.result;
    return this.pending ??= this.refresh().finally(() => { this.pending = undefined; });
  }
  private async refresh(): Promise<LofiLiveReply> {
    try {
      const stream = parseLofiLive(await this.read()), now = this.now();
      this.result = { status: stream ? 'live' : 'offline', stream, checkedAt: now };
      this.expires = now + REFRESH_MS;
    } catch {
      const now = this.now();
      this.result = unavailableLofi(this.result, now);
      this.expires = now + RETRY_MS;
    }
    return this.result;
  }
}
