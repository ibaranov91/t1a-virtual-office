import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentVacation, zonedTime, type Absence } from '../../shared/vacation';
import { createCipheriv } from 'node:crypto';
process.env.GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const { World } = await import('./world');
const { Vacations } = await import('./vacations');
const { CALENDAR_SCOPE, listAbsences, forgetAccess } = await import('./google');
import type { TileMap } from '../../shared/map';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const zone = 'Europe/Warsaw';
const at = (s: string, z = zone) => zonedTime(s.slice(0, 10), z, Number(s.slice(11, 13) || 0), Number(s.slice(14, 16) || 0));
const timed = (s: string, e: string): Absence => ({ start: at(s), end: at(e) });
const day = (s: string, e: string, z = zone): Absence => ({ start: at(s, z), end: at(e, z), allDay: { endDate: e } });
test('six-hour cutoff and half-open intervals', () => {
  assert.equal(currentVacation([timed('2026-10-19T09:00', '2026-10-19T14:59')], zone, at('2026-10-19T10:00')), null);
  const a = timed('2026-10-19T09:00', '2026-10-19T15:00');
  assert.deepEqual(currentVacation([a], zone, a.start), { until: a.end });
  assert.equal(currentVacation([a], zone, a.end), null);
});
test('weekend, touching and overlapping merge; working Tuesday does not', () => {
  const a = timed('2026-10-16T10:00', '2026-10-16T18:00'), b = timed('2026-10-19T09:00', '2026-10-19T15:00');
  assert.equal(currentVacation([b, a], zone, a.start)?.until, b.end);
  for (const start of ['2026-10-16T18:00', '2026-10-16T17:00']) {
    const c = timed(start, '2026-10-17T06:00');
    assert.equal(currentVacation([a, c], zone, a.start)?.until, c.end);
  }
  const mon = day('2026-10-19', '2026-10-20'), wed = day('2026-10-21', '2026-10-22');
  assert.equal(currentVacation([mon, wed], zone, mon.start)?.until, mon.end);
  assert.equal(currentVacation([day('2026-10-16', '2026-10-17'), mon], zone, at('2026-10-17T12:00'))?.until, mon.end);
});
test('back dates use calendar zone and exclusive all-day ends', () => {
  for (const z of [zone, 'Asia/Tokyo']) {
    const a = day('2026-10-16', '2026-10-17', z);
    assert.deepEqual(currentVacation([a], z, a.start), { until: a.end, back: '2026-10-19' });
  }
  for (const [end, back] of [['2026-10-16T18:00', '2026-10-19'], ['2026-10-21T14:00', undefined], ['2026-10-21T07:00', '2026-10-21']] as const) {
    const a = timed('2026-10-15T00:00', end);
    assert.equal(currentVacation([a], zone, a.start)?.back, back);
  }
});
test('vacations expire without polling, survive saves and expired saves are dropped', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const w = new World(structuredClone(map)), u = w.addUser('Kim');
  w.vacations.set(u.id, { until: Date.now() + 20000, back: '2026-10-19' });
  const saved = w.dump(), next = new World(structuredClone(map)); next.load(saved);
  assert.deepEqual(next.users.get(u.id)?.vacation, u.vacation);
  t.mock.timers.tick(30000); assert.equal(u.vacation, null);
  const expired = new World(structuredClone(map)); expired.load(saved); assert.equal(expired.users.get(u.id)?.vacation, null);
});

function grant(refresh: string) {
  const iv = Buffer.alloc(12, 2), cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  const body = Buffer.concat([cipher.update(refresh), cipher.final()]);
  return { email: `${refresh}@t1a.com`, refresh: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'), scopes: [CALENDAR_SCOPE] };
}
function pollSetup(t: import('node:test').TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-10-16T10:00:00Z') });
  const w = new World(structuredClone(map));
  const poller = new Vacations(w, true);
  const add = (name: string, connected = true) => {
    const u = w.addUser(name, false, undefined, `${name.toLowerCase()}@t1a.com`);
    if (connected) u.google = grant(name.toLowerCase());
    t.after(() => forgetAccess(u.id));
    return u;
  };
  const requests: URL[] = [];
  let reply = (_url: URL, _token: string): Response => Response.json({ timeZone: zone, items: [{ eventType: 'outOfOffice', summary: 'PRIVATE TITLE', start: { date: '2026-10-16' }, end: { date: '2026-10-20' } }] });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      const refresh = new URLSearchParams(String(init?.body)).get('refresh_token');
      if (refresh === 'revoked') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: refresh, expires_in: 3600 });
    }
    requests.push(url);
    return reply(url, String((init?.headers as Record<string, string>)?.authorization));
  });
  return { w, poller, add, requests, respond: (f: typeof reply) => { reply = f; } };
}
test('listAbsences filters private titles, cancelled/declined and timed default events in Warsaw and Tokyo', async t => {
  const { add, requests, respond } = pollSetup(t), u = add('Own');
  for (const z of [zone, 'Asia/Tokyo']) {
    respond(() => Response.json({ timeZone: z, items: [
      { eventType: 'default', summary: 'PRIVATE vacation', start: { date: '2026-10-16' }, end: { date: '2026-10-17' } },
      { eventType: 'default', summary: 'Dentist', start: { date: '2026-10-16' }, end: { date: '2026-10-17' } },
      { eventType: 'default', summary: 'vacation', start: { dateTime: '2026-10-16T00:00:00Z' }, end: { dateTime: '2026-10-17T00:00:00Z' } },
      { eventType: 'outOfOffice', status: 'cancelled', start: { date: '2026-10-16' }, end: { date: '2026-10-17' } },
      { eventType: 'outOfOffice', attendees: [{ self: true, responseStatus: 'declined' }], start: { date: '2026-10-16' }, end: { date: '2026-10-17' } },
    ] }));
    const result = await listAbsences(u.id, u.google!, 'primary', true);
    const expected = z === zone ? ['2026-10-15T22:00:00.000Z', '2026-10-16T22:00:00.000Z'] : ['2026-10-15T15:00:00.000Z', '2026-10-16T15:00:00.000Z'];
    assert.deepEqual(result.items, [{ start: Date.parse(expected[0]), end: Date.parse(expected[1]), allDay: { endDate: '2026-10-17' } }]);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  assert.deepEqual(requests[0].searchParams.getAll('eventTypes'), ['outOfOffice', 'default']);
});
test('polling uses own calendars and admin-first readers, with no event titles in public or saved data', async t => {
  const { w, add, poller, requests, respond } = pollSetup(t);
  const any = add('Any'), admin = add('Admin'), person = add('Person', false);
  const old = process.env.DECK_ADMINS; process.env.DECK_ADMINS = admin.email;
  t.after(() => { if (old === undefined) delete process.env.DECK_ADMINS; else process.env.DECK_ADMINS = old; });
  const tokens = new Map<string, string>();
  respond((url, token) => {
    tokens.set(decodeURIComponent(url.pathname.split('/')[4]), token);
    return Response.json({ timeZone: zone, items: [{ eventType: 'outOfOffice', summary: 'PRIVATE TITLE', start: { date: '2026-10-16' }, end: { date: '2026-10-20' } }] });
  });
  await poller.poll();
  assert.equal(requests.filter(r => r.pathname.includes('/primary/')).length, 2);
  const read = requests.find(r => decodeURIComponent(r.pathname).includes(person.email!))!;
  assert.deepEqual(read.searchParams.getAll('eventTypes'), ['outOfOffice']);
  assert.ok(!read.searchParams.get('fields')!.includes('summary'));
  assert.equal(tokens.get(person.email!), 'Bearer admin');
  assert.ok(any.vacation && person.vacation);
  assert.ok(!JSON.stringify([w.snapshot(), w.dump()]).includes('PRIVATE TITLE'));
});
test('pagination follows five pages at most and uses all pages for the current vacation', async t => {
  const { add, respond, requests } = pollSetup(t), u = add('Pages');
  respond(url => {
    const n = Number(url.searchParams.get('pageToken') ?? 0);
    return Response.json({ timeZone: zone, nextPageToken: String(n + 1), items: [{ eventType: 'outOfOffice', start: { date: `2026-10-${16 + n}` }, end: { date: `2026-10-${17 + n}` } }] });
  });
  const result = await listAbsences(u.id, u.google!, 'primary', true);
  assert.equal(requests.length, 5); assert.equal(result.items.length, 5);
  assert.equal(currentVacation(result.items, zone)?.until, Date.parse('2026-10-20T22:00:00Z'));
});
test('403 and 404 clear data and log once per person; transient errors keep last result', async t => {
  const { add, poller, respond } = pollSetup(t), u = add('Errors');
  const warnings = t.mock.method(console, 'warn', () => {});
  await poller.poll(); const saved = u.vacation; assert.ok(saved);
  respond(() => Response.json({}, { status: 500 })); await poller.poll(); assert.deepEqual(u.vacation, saved);
  respond(() => Response.json({}, { status: 403 })); await poller.poll(); assert.equal(u.vacation, null);
  respond(() => Response.json({}, { status: 404 })); await poller.poll();
  assert.equal(warnings.mock.calls.filter(c => String(c.arguments[0]).includes('unavailable')).length, 1);
});
test('revoked reader loses its grant and next reader retries the person within the same poll', async t => {
  const { add, poller, requests } = pollSetup(t);
  const person = add('Person', false), revoked = add('Bad'), next = add('Good'); revoked.google = grant('revoked');
  const old = process.env.DECK_ADMINS; process.env.DECK_ADMINS = revoked.email;
  t.after(() => { if (old === undefined) delete process.env.DECK_ADMINS; else process.env.DECK_ADMINS = old; });
  await poller.poll();
  assert.equal(revoked.google, undefined); assert.ok(person.vacation); assert.ok(next.google);
  assert.ok(requests.some(r => decodeURIComponent(r.pathname).includes(person.email!)));
});
test('revoked owner loses only the failed grant and receives private me', async t => {
  const { w, add, poller } = pollSetup(t), u = add('Owner'); u.google = grant('revoked');
  const messages: import('../../shared/protocol').ServerMsg[] = []; w.connect(u.id, m => messages.push(m)); messages.length = 0;
  await poller.poll(); assert.equal(u.google, undefined); assert.ok(messages.some(m => m.t === 'me'));
});

test('polls start after five seconds, repeat after ten minutes and follow newly granted calendar scope', async t => {
  const { w, add, poller, requests } = pollSetup(t); const u = add('Schedule'); w.vacations = poller;
  t.mock.method(w.meetings, 'poll', async () => {});
  const drain = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(r => setImmediate(r)); };
  t.mock.timers.tick(4999); await drain(); assert.equal(requests.length, 0);
  t.mock.timers.tick(1); await drain(); assert.equal(requests.length, 1);
  t.mock.timers.tick(595000); await drain(); assert.equal(requests.length, 2);
  const newcomer = add('NewScope', false);
  w.setGoogle(newcomer, grant('newscope'));
  const count = requests.length;
  t.mock.timers.tick(4999); await drain(); assert.equal(requests.length, count);
  t.mock.timers.tick(1); await drain(); assert.equal(requests.length, count + 2);
  assert.ok(u.vacation && newcomer.vacation);
});
test('concurrent polls never fetch a calendar twice', async t => {
  const { add, poller, requests } = pollSetup(t); add('Serial');
  let unblock!: () => void;
  const blocked = new Promise<void>(r => { unblock = r; });
  const response = Response.json({ timeZone: zone, items: [] });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'serial', expires_in: 3600 });
    requests.push(url); await blocked; return response;
  });
  const first = poller.poll(); await new Promise<void>(r => setImmediate(r));
  await poller.poll(); assert.equal(requests.length, 1);
  unblock(); await first;
});
