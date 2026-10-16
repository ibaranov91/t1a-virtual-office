// Pure helpers for NetBird sign-in: who may vouch for a user (by source address) and what to call them.

/** A dotted IPv4 address (IPv4-mapped IPv6 included) as an unsigned 32-bit number, or null. */
const ip4 = (ip: string) => {
  const m = ip.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0 : null;
};

/** Is `ip` inside `cidr` ("10.200.0.0/16"; a bare address is a /32)? Anything that isn't IPv4 is outside. */
export const inCidr = (ip: string, cidr: string) => {
  const [base, bits = '32'] = cidr.split('/');
  const a = ip4(ip), b = ip4(base), n = Number(bits);
  if (a === null || b === null || !(n >= 0 && n <= 32)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (a & mask) === (b & mask);
};

/** One plain email address, trimmed and lower-cased, or null. */
export const cleanEmail = (raw: unknown) => {
  const email = String(raw ?? '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email) ? email : null;
};

/** The email in an `X-NetBird-User` header value (a repeated header: the first one), or null. */
export const netbirdUserEmail = (raw: string | string[] | undefined) => cleanEmail(Array.isArray(raw) ? raw[0] : raw);

/** "ivan.baranov@t1a.com" -> "Ivan Bar": first name plus the first three letters of the last name */
export const nameFromEmail = (email: string) => {
  const [first, ...rest] = email.split('@')[0].split(/[._+-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1));
  const last = rest.at(-1);
  return (last ? `${first} ${last.slice(0, 3)}` : first)?.slice(0, 24) || email;
};
