// Dev-only: 12 fake teammates that wander between spots, idle, and change status/presence.
import { isWalkable } from '../../shared/map';
import type { User, World } from './world';

const NAMES = ['Maya', 'Leo', 'Priya', 'Sam', 'Ines', 'Tomas', 'Aiko', 'Ben', 'Zoe', 'Omar', 'Nina', 'Felix'];
const STATUSES = [
  'deep in the Acme SOW', 'pairing on dbt models', 'reviewing PRs', 'lunch 🍜', 'writing the QBR deck',
  'debugging a flaky pipeline', 'client call prep', 'on the Lakehouse migration', 'heads down till 3',
  'coffee refill ☕', 'drafting the proposal', 'happy to chat', 'onboarding the new joiner', '',
];
// how much each room attracts wandering bots
const ROOM_WEIGHT: Record<string, number> = { focus: 3, cowork: 4, coffee: 2.5, lobby: 1.2, meeting: 1.5 };

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const pickWeighted = <T>(xs: T[], w: (x: T) => number) => {
  const total = xs.reduce((s, x) => s + w(x), 0); let r = Math.random() * total;
  for (const x of xs) { r -= w(x); if (r <= 0) return x; }
  return xs[xs.length - 1];
};

export function startBots(world: World, count = 4) {
  const map = world.map;
  const names = NAMES.slice(0, Math.max(0, Math.min(NAMES.length, count)));
  // drop persisted bots beyond the configured count
  for (const u of [...world.users.values()]) if (u.bot && !names.includes(u.name)) world.users.delete(u.id);
  for (const name of names) {
    if (world.findByName(name)) continue;
    const u = world.addUser(name, true);
    const room = pick(map.rooms);
    const spot = pick(room.spots);
    u.tile = { x: spot.x, y: spot.y }; u.dir = spot.dir;
    u.status = pick(STATUSES);
  }
  const bots = () => [...world.users.values()].filter(u => u.bot);
  const next = new Map<string, number>();
  const presenceUntil = new Map<string, number>();
  for (const b of bots()) { next.set(b.id, Date.now() + Math.random() * 6000); if (b.presence === 'offline') b.presence = 'online'; }

  const goSomewhere = (b: User, preferRoom?: string) => {
    const occ = world.occupied();
    const room = preferRoom ? map.rooms.find(r => r.id === preferRoom)! : pickWeighted(map.rooms, r => ROOM_WEIGHT[r.id] ?? 1);
    const free = room.spots.filter(s => !occ.has(`${s.x},${s.y}`));
    if (free.length) {
      const s = pick(free);
      world.walk(b, s, s.dir);
      return;
    }
    // wander to any free tile in the room
    for (let i = 0; i < 20; i++) {
      const x = room.rect.x + Math.floor(Math.random() * room.rect.w), y = room.rect.y + Math.floor(Math.random() * room.rect.h);
      if (isWalkable(map, x, y) && !occ.has(`${x},${y}`)) { world.walk(b, { x, y }); return; }
    }
  };

  setInterval(() => {
    const now = Date.now();
    for (const b of bots()) {
      const until = presenceUntil.get(b.id);
      if (until && now > until) { world.setPresence(b, 'online'); presenceUntil.delete(b.id); }
      if ((next.get(b.id) ?? 0) > now) continue;
      next.set(b.id, now + 6000 + Math.random() * 22000);
      if (b.presence === 'away') continue; // asleep at the desk
      const r = Math.random();
      if (r < 0.55) goSomewhere(b);
      else if (r < 0.7) world.setStatus(b, pick(STATUSES));
      else if (r < 0.8) { world.setPresence(b, 'away'); presenceUntil.set(b.id, now + 25000 + Math.random() * 50000); }
      else if (r < 0.88) { world.setPresence(b, 'in_call'); presenceUntil.set(b.id, now + 25000 + Math.random() * 40000); if (Math.random() < 0.6) goSomewhere(b, 'meeting'); }
      else if (r < 0.92) {
        // occasionally knock on a human who is online, so solo testing sees incoming knocks
        const humans = [...world.users.values()].filter(u => !u.bot && u.presence === 'online');
        const others = bots().filter(o => o.id !== b.id && o.presence === 'online');
        const target = humans.length && Math.random() < 0.5 ? pick(humans) : others.length ? pick(others) : null;
        if (target) world.knock(b, target);
      }
    }
  }, 500);
}
