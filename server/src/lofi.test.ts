import test from 'node:test';
import assert from 'node:assert/strict';
import { LofiLive, parseLofiLive } from './lofi';
const title = 'lofi hip hop radio 📚 beats to relax/study to';
const modern = (videoId: string, live = true, name = title) => ({ lockupViewModel: {
  contentId: videoId, metadata: { lockupMetadataViewModel: { title: { content: name } } },
  contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: {
    badgeStyle: live ? 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' : 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT',
  } }] } }] } },
} });
const page = (items: unknown[], channel = 'UCSJ4gkVC6NrvII8umztf0Ow') => `<script>var ytInitialData = ${JSON.stringify({
  metadata: { channelMetadataRenderer: { externalId: channel } },
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { richGridRenderer: { contents: items } } } }] } },
})};</script>`;

test('finds the live study radio, skipping recordings, upcoming and other Lofi Girl stations', () => {
  const html = page([modern('oldRadio123', false), modern('otherLive12', true, 'lofi house radio'), modern('liveRadio12')]);
  assert.deepEqual(parseLofiLive(html), { videoId: 'liveRadio12', title });
  assert.equal(parseLofiLive(page([modern('oldRadio123', false)])), null);
  assert.equal(parseLofiLive(page([])), null);
});
test('accepts the legacy live renderer and ignores badges outside its video', () => {
  const legacy = { videoRenderer: { videoId: 'legacyLive1', title: { runs: [{ text: title }] }, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }] } };
  assert.deepEqual(parseLofiLive(page([legacy])), { videoId: 'legacyLive1', title });
  assert.equal(parseLofiLive(page([{ ...modern('bad-id'), badges: [{ style: 'LIVE' }] }])), null);
});
test('refuses the wrong channel, consent pages and changed page structure', () => {
  for (const html of [page([modern('liveRadio12')], 'a-different-channel'), '<html>Consent</html>', '<script>var ytInitialData = {};</script>'])
    assert.throws(() => parseLofiLive(html));
});
test('shares in-flight lookups, caches them and discovers a replacement broadcast', async () => {
  let now = 1000, calls = 0, html = page([modern('liveRadio12')]);
  const live = new LofiLive(async () => { calls++; return html; }, () => now);
  const results = await Promise.all([live.get(), live.get(), live.get()]);
  assert.equal(calls, 1); assert.equal(results[0].stream?.videoId, 'liveRadio12');
  now += 299_999; html = page([modern('newRadio123')]);
  assert.equal((await live.get()).stream?.videoId, 'liveRadio12'); assert.equal(calls, 1);
  now++; assert.equal((await live.get()).stream?.videoId, 'newRadio123'); assert.equal(calls, 2);
  now += 300_000; html = page([]);
  assert.deepEqual(await live.get(), { status: 'offline', stream: null, checkedAt: now });
});
test('upstream failure is not LIVE, retries are bounded and old cached streams expire', async () => {
  let now = 1000, broken = false, calls = 0;
  const live = new LofiLive(async () => { calls++; if (broken) throw Error('network'); return page([modern('liveRadio12')]); }, () => now);
  await live.get(); broken = true; now += 300_000;
  const stale = await live.get(); assert.equal(stale.status, 'unavailable'); assert.equal(stale.stream?.videoId, 'liveRadio12');
  await live.get(); assert.equal(calls, 2);
  now += 30 * 60_000; assert.equal((await live.get()).stream, null);
  broken = false; now += 60_000; assert.equal((await live.get()).status, 'live');
});
