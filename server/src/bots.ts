// Dev-only: 12 fake teammates that wander between spots, idle, and change status/presence.
import { isWalkable } from '../../shared/map';
import { dayNumber, PLANT_STAGES } from '../../shared/protocol';
import type { User, World } from './world';

const NAMES = ['Maya', 'Leo', 'Priya', 'Sam', 'Ines', 'Tomas', 'Aiko', 'Ben', 'Zoe', 'Omar', 'Nina', 'Felix'];
const STATUSES = [
  'deep in the Acme SOW', 'pairing on dbt models', 'reviewing PRs', 'lunch 🍜', 'writing the QBR deck',
  'debugging a flaky pipeline', 'client call prep', 'on the Lakehouse migration', 'heads down till 3',
  'coffee refill ☕', 'drafting the proposal', 'happy to chat', 'onboarding the new joiner', '',
];
const REPLIES = [
  'Hey! 👋', 'On it, give me 5 min', 'Sure, knock any time', 'Haha, nice', 'Grabbing a coffee first ☕',
  'Can we sync after lunch?', 'Thanks!', 'Sounds good to me', 'Ooh, tell me more',
];
// how much each room attracts wandering bots
const ROOM_WEIGHT: Record<string, number> = { focus: 3, cowork: 4, studio: 2, desks: 2.5, coffee: 2.5, lobby: 1.2, meeting: 1.5 };

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
  // bots' plants start at random ages (some long dead) so the desks and the Orangery look lived in
  const today = dayNumber(Date.now());
  for (const b of [...world.users.values()]) if (b.bot && !b.plant) b.plant = { stage: Math.floor(Math.random() * PLANT_STAGES.length), care: today - Math.floor(Math.random() * 10) };
  world.botHooks = {
    chat: (b, from) => setTimeout(() => world.chat(b, from, pick(REPLIES)), 1200 + Math.random() * 2000),
    react: (b, from) => { if (Math.random() < 0.6) setTimeout(() => world.react(b, from, pick(['👋', '👍', '❤️', '😂'])), 700 + Math.random() * 1200); },
  };
  const treats = map.objects.filter(o => o.use?.kind === 'take');
  const bots = () => [...world.users.values()].filter(u => u.bot);
  const next = new Map<string, number>();
  const presenceUntil = new Map<string, number>();
  for (const b of bots()) { next.set(b.id, Date.now() + Math.random() * 6000); b.presence = 'online'; } // away/in-call timers aren't persisted, so start fresh

  const goSomewhere = (b: User, preferRoom?: string) => {
    const occ = world.occupied();
    for (const d of world.claimedDesks()) occ.add(d); // never sit at someone's home desk
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
      if (b.callId) { presenceUntil.delete(b.id); continue; } // on a call: stay put
      const until = presenceUntil.get(b.id);
      if (until && now > until) { world.setPresence(b, 'online'); presenceUntil.delete(b.id); }
      if ((next.get(b.id) ?? 0) > now) continue;
      next.set(b.id, now + 6000 + Math.random() * 22000);
      if (b.presence === 'away') continue; // asleep at the desk
      const r = Math.random();
      if (r < 0.55) goSomewhere(b);
      else if (r < 0.7) world.setStatus(b, pick(STATUSES));
      else if (r < 0.8) { world.setPresence(b, 'away'); presenceUntil.set(b.id, now + 25000 + Math.random() * 50000); }
      else if (r < 0.84) { world.setPresence(b, 'in_call'); presenceUntil.set(b.id, now + 25000 + Math.random() * 40000); if (Math.random() < 0.6) goSomewhere(b, 'meeting'); }
      else if (r < 0.88 && treats.length) world.use(b, pick(treats).id); // coffee break
      else if (r < 0.92) {
        // bots only knock on each other (never on real people), so the floor has some life
        const others = bots().filter(o => o.id !== b.id && o.presence === 'online');
        if (others.length) world.knock(b, pick(others));
      }
    }
  }, 500);
}
