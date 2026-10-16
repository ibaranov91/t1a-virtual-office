import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentVacation, zonedTime, type Absence } from '../../shared/vacation';
import { createCipheriv } from 'node:crypto';
process.env.GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const { World } = await import('./world');
const { Vacations } = await import('./vacations');
const { CALENDAR_SCOPE, listAbsences, listTeamAbsences, forgetAccess } = await import('./google');
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
const teamCalendar = 't1a.com_aoas0mu6l5d0hmrdhabm01rc0k@group.calendar.google.com';
const isTeam = (url: URL) => decodeURIComponent(url.pathname).includes(teamCalendar);
function pollSetup(t: import('node:test').TestContext, team = false) {
  const oldTeam = process.env.VACATION_TEAM_CALENDAR;
  if (team) delete process.env.VACATION_TEAM_CALENDAR; else process.env.VACATION_TEAM_CALENDAR = '';
  t.after(() => { if (oldTeam === undefined) delete process.env.VACATION_TEAM_CALENDAR; else process.env.VACATION_TEAM_CALENDAR = oldTeam; });
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

const teamEvent = (summary: string, extra = {}) => ({ summary, eventType: 'default', creator: { email: 't1a.api@t1a.com' }, start: { date: '2026-10-16' }, end: { date: '2026-10-17' }, ...extra });
test('team-only vacations match attendee, creator and diacritic names, ignore business travel and hide summaries', async t => {
  const { w, add, poller, requests, respond } = pollSetup(t, true);
  add('Reader');
  const attendee = add('Ada', false), creator = add('Grace', false), named = add('Other', false), business = add('Maria', false), display = add('Katherine Johnson', false);
  attendee.email = 'ada.lovelace@t1a.com'; creator.email = 'grace.hopper@t1a.com'; named.email = 'antonin.dvorak@t1a.com';
  named.tz = 'Asia/Tokyo';
  const messages: unknown[] = []; w.connect(attendee.id, m => messages.push(m));
  const warnings = t.mock.method(console, 'warn', () => {});
  const events = [
    teamEvent('Ada Lovelace - Time OFF SD-1001', { attendees: [{ email: attendee.email!.toUpperCase(), responseStatus: 'declined' }] }),
    teamEvent('Grace Hopper - Time OFF', { creator: { email: creator.email }, transparency: 'transparent' }),
    teamEvent('Antonín Dvořák - Time OFF SD-1002'),
    teamEvent('Katherine Johnson - Vacation'),
    teamEvent('Maria - Business Trip vacation SD-1003', { attendees: [{ email: business.email }] }),
    teamEvent('Maria - Travel holiday', { attendees: [{ email: business.email }] }),
    teamEvent('Maria - Vacation', { status: 'cancelled', attendees: [{ email: business.email }] }),
  ];
  respond(url => isTeam(url) ? Response.json({ timeZone: 'America/New_York', items: events }) : Response.json({}, { status: 403 }));
  await poller.poll();
  for (const u of [attendee, creator, display]) assert.deepEqual(u.vacation, { until: Date.parse('2026-10-16T22:00:00Z'), back: '2026-10-19' });
  assert.deepEqual(named.vacation, { until: Date.parse('2026-10-16T15:00:00Z'), back: '2026-10-19' });
  assert.ok(!business.vacation);
  assert.equal(requests.filter(isTeam).length, 1);
  assert.equal(requests.find(isTeam)!.searchParams.get('fields'), 'nextPageToken,timeZone,items(status,summary,start,end,creator(email),attendees(email))');
  const output = JSON.stringify([w.snapshot(), w.dump(), messages, warnings.mock.calls]);
  for (const e of events) assert.ok(!output.includes(e.summary));
});
test('team items merge with OOO using the successful personal calendar timezone', async t => {
  const { add, poller, respond } = pollSetup(t, true), u = add('Merge'); u.tz = 'Asia/Tokyo';
  respond(url => Response.json(isTeam(url) ? { timeZone: 'America/New_York', items: [teamEvent('Merge - day-off', { start: { date: '2026-10-19' }, end: { date: '2026-10-21' } })] } : { timeZone: zone, items: [{ eventType: 'outOfOffice', start: { date: '2026-10-16' }, end: { date: '2026-10-17' } }] }));
  await poller.poll();
  assert.deepEqual(u.vacation, { until: Date.parse('2026-10-20T22:00:00Z'), back: '2026-10-21' });
});
test('team reader 403 falls back, reads once per poll and retains the last team result on failure', async t => {
  const { add, poller, respond, requests } = pollSetup(t, true);
  const first = add('First'), second = add('Second'), person = add('Person', false);
  const old = process.env.DECK_ADMINS; process.env.DECK_ADMINS = first.email;
  t.after(() => { if (old === undefined) delete process.env.DECK_ADMINS; else process.env.DECK_ADMINS = old; });
  let fail = false;
  const tokens: string[] = [];
  const warnings = t.mock.method(console, 'warn', () => {});
  respond((url, token) => {
    if (!isTeam(url)) return Response.json({ timeZone: zone, items: [] });
    tokens.push(token);
    return fail || token === 'Bearer first' ? Response.json({}, { status: 403 }) : Response.json({ items: [teamEvent('Person - TimeOFF')] });
  });
  await poller.poll();
  assert.deepEqual(tokens, ['Bearer first', 'Bearer second']);
  assert.ok(person.vacation); assert.ok(second.google);
  const saved = person.vacation; fail = true;
  await poller.poll(); await poller.poll();
  assert.deepEqual(person.vacation, saved);
  assert.equal(requests.filter(isTeam).length, 6);
  assert.equal(warnings.mock.calls.length, 1);
});
test('team reader invalid_grant drops the grant and retries another reader', async t => {
  const { add, poller, respond } = pollSetup(t, true);
  const bad = add('Bad'); bad.google = grant('revoked'); add('Good'); const person = add('Person', false);
  respond(url => Response.json({ timeZone: zone, items: isTeam(url) ? [teamEvent('Person - Vacation')] : [] }));
  await poller.poll();
  assert.equal(bad.google, undefined); assert.ok(person.vacation);
});
test('empty team calendar env disables team reads', async t => {
  const { add, poller, requests } = pollSetup(t); add('Own');
  await poller.poll(); assert.equal(requests.filter(isTeam).length, 0);
});
test('own calendar accepts time off and day-off but excludes business trip and travel', async t => {
  const { add, respond } = pollSetup(t), u = add('Keywords');
  respond(() => Response.json({ timeZone: zone, items: ['Time OFF', 'day-off', 'dayoff', 'vacation business trip', 'holiday travel'].map(s => teamEvent(s)) }));
  const result = await listAbsences(u.id, u.google!, 'primary', true);
  assert.equal(result.items.length, 3);
});

test('team API paginates five pages, preserves dates and timed epochs, and strips summaries and service creators', async t => {
  const { add, respond, requests } = pollSetup(t), u = add('Reader');
  respond(url => Response.json({ timeZone: 'America/New_York', nextPageToken: String(Number(url.searchParams.get('pageToken') ?? 0) + 1), items: [
    teamEvent('Nobody - Vacation PRIVATE', { creator: { email: teamCalendar.toUpperCase() } }),
    teamEvent('Someone - PTO PRIVATE', { creator: { email: 'PERSON@T1A.COM' }, start: { dateTime: '2026-10-16T08:00:00Z' }, end: { dateTime: '2026-10-16T16:00:00Z' } }),
  ] }));
  const result = await listTeamAbsences(u.id, u.google!, teamCalendar);
  assert.equal(requests.length, 5); assert.equal(result.items.length, 10);
  assert.deepEqual(result.items[0], { who: { emails: [], name: 'Nobody' }, start: '2026-10-16', end: '2026-10-17' });
  assert.deepEqual(result.items[1], { who: { emails: ['person@t1a.com'], name: 'Someone' }, start: 1792137600000, end: 1792166400000 });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(result.timeZone, 'America/New_York');
});
