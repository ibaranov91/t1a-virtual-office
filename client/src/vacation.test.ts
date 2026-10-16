import test from 'node:test';
import assert from 'node:assert/strict';
import { vacationReturnLabel, vacationPeople } from './Vacation';

test('an all-day return stays on its calendar date in every viewer zone', () => {
  const vacation = { until: Date.parse('2026-10-26T23:00:00Z'), back: '2026-10-27' };
  for (const zone of ['Pacific/Honolulu', 'Asia/Tokyo']) {
    assert.equal(vacationReturnLabel(vacation, 'en-GB', zone), 'back Tue 27 Oct');
  }
});
test('a timed return uses the viewer zone and locale', () => {
  const vacation = { until: Date.parse('2026-10-21T12:00:00Z') };
  assert.equal(vacationReturnLabel(vacation, 'en-GB', 'Europe/Warsaw'), 'back Wed 21 Oct, 14:00');
  assert.equal(vacationReturnLabel(vacation, 'en-GB', 'Asia/Tokyo'), 'back Wed 21 Oct, 21:00');
  assert.match(vacationReturnLabel(vacation, 'pl-PL', 'Europe/Warsaw'), /paź/);
});
test('the vacation list includes online and offline people sorted by return', () => {
  const users = [
    { id: 'later', presence: 'offline', vacation: { until: 30 } },
    { id: 'working', presence: 'online', vacation: null },
    { id: 'sooner', presence: 'online', vacation: { until: 10 } },
  ];
  assert.deepEqual(vacationPeople(users).map(u => u.id), ['sooner', 'later']);
  assert.equal(users[0].id, 'later');
});
