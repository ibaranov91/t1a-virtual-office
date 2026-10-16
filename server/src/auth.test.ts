import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEmail, inCidr, nameFromEmail, netbirdUserEmail } from './auth';

test('inCidr: IPv4 ranges, IPv4-mapped addresses, and anything malformed is outside', () => {
  assert.equal(inCidr('10.200.142.211', '10.200.0.0/16'), true);
  assert.equal(inCidr('::ffff:10.200.3.4', '10.200.0.0/16'), true, 'Node reports IPv4 peers as IPv4-mapped IPv6');
  assert.equal(inCidr('10.201.0.1', '10.200.0.0/16'), false);
  assert.equal(inCidr('192.0.2.1', '192.0.2.1'), true, 'a bare address is a /32');
  assert.equal(inCidr('192.0.2.2', '192.0.2.1/32'), false);
  assert.equal(inCidr('8.8.8.8', '0.0.0.0/0'), true);
  for (const [ip, cidr] of [['::1', '0.0.0.0/0'], ['abc', '10.0.0.0/8'], ['10.0.0.1', '10.0.0.0/33'], ['10.0.0.1', 'nope/8'], ['', '10.0.0.0/8']]) {
    assert.equal(inCidr(ip, cidr), false, `${ip} in ${cidr}`);
  }
});

test('cleanEmail and netbirdUserEmail: one trimmed, lower-cased address or nothing', () => {
  assert.equal(cleanEmail(' Kim@T1A.com'), 'kim@t1a.com'); assert.equal(cleanEmail(42), null); assert.equal(cleanEmail(null), null);
  assert.equal(netbirdUserEmail(' Ivan.Baranov@T1A.com '), 'ivan.baranov@t1a.com');
  assert.equal(netbirdUserEmail(['kim@t1a.com', 'other@t1a.com']), 'kim@t1a.com', 'a repeated header: the first value');
  for (const raw of [undefined, '', 'no-at-sign', 'two words@t1a.com', `${'x'.repeat(65)}@t1a.com`, 'a@b@c']) {
    assert.equal(netbirdUserEmail(raw), null, String(raw));
  }
});

test('nameFromEmail: first name plus three letters of the last, at most 24 characters', () => {
  assert.equal(nameFromEmail('ivan.baranov@t1a.com'), 'Ivan Bar');
  assert.equal(nameFromEmail('kim@t1a.com'), 'Kim');
  assert.equal(nameFromEmail('anna-maria.smith_jones@t1a.com'), 'Anna Jon');
  assert.equal(nameFromEmail(`${'a'.repeat(30)}@t1a.com`), 'A' + 'a'.repeat(23));
  assert.equal(nameFromEmail('.@t1a.com'), '.@t1a.com', 'nothing usable: the address itself');
});
