import test from 'node:test';
import assert from 'node:assert/strict';
import { unavailableLofi, type LofiLiveReply } from '../../shared/lofi';

test('losing the lookup endpoint retains a recent stream without claiming LIVE, then expires it', () => {
  const previous: LofiLiveReply = { status: 'live', checkedAt: 1000, stream: { videoId: 'liveRadio12', title: 'Study radio' } };
  const recent = unavailableLofi(previous, 1_800_999);
  assert.equal(recent.status, 'unavailable'); assert.equal(recent.stream?.videoId, 'liveRadio12'); assert.equal(recent.checkedAt, 1000);
  assert.deepEqual(unavailableLofi(recent, 1_801_000), { status: 'unavailable', stream: null, checkedAt: 1000 });
  assert.deepEqual(unavailableLofi(null, 1000), { status: 'unavailable', stream: null, checkedAt: null });
});
