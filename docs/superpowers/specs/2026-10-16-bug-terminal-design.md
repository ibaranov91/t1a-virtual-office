# Bug terminal: report bugs from a green-screen terminal in the Lobby — design

Owner: Ivan Baranov · 2026-10-16 · status: approved. Look picked from mockups: sprite A (desk CRT), screen B
(full-screen numbered menu), green phosphor.

## Goal

A chunky old computer terminal by reception. Walk up, click it, and a green phosphor screen opens. Anyone can file a
ticket and read their own tickets with the replies. Office admins (`DECK_ADMINS`) get the same terminal with one
more menu item: the open queue, where they reply, mark fixed or close.

- It's a place in the office, not a settings menu. You walk to the terminal, as you walk to the jukebox.
- A ticket is a short thread: the report, then replies from both sides.
- Tickets are private to their author and the admins. Nothing about them is ever broadcast.

## Decisions and why

| decision | why |
| --- | --- |
| Admins = office admins (`isAdmin`), not sysadmins | They already run the office (edit mode, GM panel); no new env var |
| You must stand at the terminal to open it (`reach`, like the arcade) | It's a place; walking over is the point. On phones the click walks you there too |
| One terminal, in the Lobby, free space at 2,14 | Everyone passes through the Lobby; the spot is free and away from the doorway and reception queue |
| Statuses: `open`, `fixed`, `closed` (won't fix / duplicate / not a bug) | Enough for 30 people; anything more is a tracker |
| Reporter's client context is attached automatically | "It doesn't work" is useless without browser, app or web, build and where you were |
| Admin replies reach the reporter as a notice plus a blinking terminal | Ties the reply back to the place; no email, no new notification channel |
| Saved in `state.json` | Tickets must survive deploys; volume is tiny |
| Ticket numbers are sequential (`#0042`) | Easy to say out loud in a call: "that's forty-two" |
| Plain text only, no screenshots in v1 | Uploads need a quota and a sweep (see Presentation); maybe later |

## 1. The map (`scripts/gen-map.mjs`)

Append at the end of the object list (ids are positional):

```js
obj('terminal', 3, 14, 2, 1, { use: { kind: 'tickets', label: 'bug terminal' } }); // Lobby: file a bug, read replies
```

A 2×1 desk with a beige CRT and keyboard; you use it from the tile below (3,15 or 4,15). `npm run gen` checks it is
reachable. Add `'terminal'` to `KEEP_TYPES` so edit mode can move it but never lose it, and to `withNewFixtures` so
saved layouts get it.

## 2. The object (`shared/map.ts`)

- `ObjectUse`: `{ kind: 'tickets'; label: string }`.
- `USE_KINDS.tickets = { use: true, reach: true }`: the generic `use` intent walks you beside it; on arrival the
  server sends `terminal_open` (same pattern as the Meeting room screen). layoutProblem keeps it reachable.
- `objectName('terminal')` → "bug terminal".
- App.tsx `e.onPick`: `if (use?.kind === 'tickets') return store.use(p.id)`. Walking away closes the panel.

## 3. Data (`shared/protocol.ts`)

```ts
export type TicketStatus = 'open' | 'fixed' | 'closed';
export interface TicketMsg { by: string; admin: boolean; text: string; at: number }
export interface TicketContext { ua: string; app: 'web' | 'mac'; build: string; viewport: string; room?: string; tile?: { x: number; y: number } }
export interface Ticket {
  id: number;           // sequential, shown as #0042
  by: string;           // author's user id
  title: string;        // ≤ TICKET_TITLE_MAX (80)
  status: TicketStatus;
  at: number; updated: number;
  context: TicketContext;
  msgs: TicketMsg[];    // msgs[0] is the report body; ≤ TICKET_TEXT_MAX (2000) each, ≤ 50 per ticket
  seen: Record<string, number>; // userId → last read time (author, and each admin)
}
```

Client → server (one block in `ClientMsg`):

| message | who | effect |
| --- | --- | --- |
| `ticket_new { title, text, context }` | anyone, standing at the terminal | creates `#n`, status `open` |
| `ticket_reply { id, text }` | author or admin | appends; an author's reply reopens a `fixed` ticket |
| `ticket_status { id, status }` | admin; author may only `closed` their own | sets status, adds a system line ("Marked fixed by Kim") |
| `ticket_seen { id }` | author or admin | updates `seen[me]` |

Server → client: `terminal_open { objectId }` on arrival, and `tickets { list: Ticket[] }`, only to you. Authors get their own tickets; admins get all of them.
Sent on connect (so the unread mark works anywhere) and to every affected online user on each change.

Server validation: strings trimmed and capped, `context` fields cut to 200 chars each, the room/tile taken from the
server's own `u.tile` (not trusted from the client). Limits: 5 open tickets per person, one new ticket per 30 s,
bots never. Over 1000 tickets, the oldest `closed`/`fixed` drop off first.

## 4. Server (`server/src/tickets.ts`)

A `Tickets` class like `Library`: `add`, `reply`, `setStatus`, `seen`, `visibleTo(userId, admin)`,
`unread(userId, admin)`, `dump`/`load`. World gets a `// ---------- bug terminal ----------` block that checks the
user stands beside the terminal for `ticket_new` (replies and status work anywhere once the panel is open, so an admin
can answer from the GM panel later), calls the class and sends `tickets` to the author plus every online admin.

Notifications:
- An admin reply or status change → the author gets a `notice` ("📟 Reply on #0042 at the Lobby terminal") if online.
- A new ticket or an author's reply → online admins get a `notice` ("📟 New bug #0043 from Kim").
- Unread is derived from `seen`: for the author, messages from admins after `seen[author]`; for admins, open tickets
  whose last message is not from an admin.

Optional achievement `bughunter` (🐛 "Bug hunter": one of your tickets was marked fixed), via `award`.

## 5. The screen (`client/src/Terminal.tsx`)

A CRT in React chrome: black glass with a rounded bezel, `#33ff66` text in a monospace pixel font, faint scanlines
and glow (CSS only), a blinking block cursor. Text appears with a quick typewriter reveal on screen changes (skipped
with `prefers-reduced-motion`). A short boot line the first time: `T1A DECK BUGNET v1.0 · READY`.

```
 T1A DECK BUGNET v1.0                     KIM · 14:02
 ──────────────────────────────────────────────────
  [1] NEW TICKET
  [2] MY TICKETS (3)        * 1 NEW REPLY
  [3] OPEN QUEUE (5)        ← admins only
  [ESC] LOG OFF
 ──────────────────────────────────────────────────
 > _
```

- **New ticket:** `TITLE>` then `DESCRIBE THE BUG>` (multi-line, Ctrl/⌘+Enter sends), a dim line showing the context
  that will be attached, then `TICKET #0043 FILED. THANK YOU.`
- **My tickets / Open queue:** a list with `#id  STATUS  TITLE  updated`, `*` on unread; arrows or click to open.
- **A ticket:** the thread with `KIM 14:02` / `ADMIN·IVAN 14:10` headers, then `REPLY>`. Admins also get
  `[F] FIXED  [C] CLOSE  [O] REOPEN` and the context block.
- Everything is clickable as well as keyboard-driven. Number keys and Esc work; instrument keys stay quiet while it's
  open (`dialogOpen`).
- COMPACT: a full-height bottom sheet, same look.

Store (`net.ts`): `tickets: Ticket[]`, `terminalOpen`, `openTerminal(objectId)`, `closeTerminal()`, one-liners for the
four intents, and `ticketsUnread` computed from `seen`.

## 6. The sprite and the blink

`gen-assets.mjs`, a new `// ---------- bug terminal` block at the end: a 32×16 beige desk with a CRT showing green
lines, plus `terminal_blink` with a brighter screen and a small LED. engine.ts picks `terminal_blink` on a slow blink
while *you* have unread tickets (author: replies; admin: queue waiting). Only you see your terminal blink, since
unread is per person. The hover tooltip says "Bug terminal · 1 new reply".

The sidebar's Lobby `RoomMenu` lists the terminal through `roomThings` like the other panels.

## 7. Tests (`server/src/tickets.test.ts`)

- Filing needs presence at the terminal; bots can't; caps and the 30 s limit hold.
- An author sees only their own tickets; an admin sees all; a third person gets nothing on any change.
- Reply by an author reopens `fixed`; a non-admin can't set `fixed` or touch someone else's ticket.
- Unread for author and admin from `seen`; `ticket_seen` clears it.
- `dump`/`load` round trip; trimming at 1000 drops closed tickets first.

## Not now

- Screenshots or a canvas snapshot attached to a ticket.
- Mirroring to GitHub Issues or Jira (the data has everything a sync would need: id, title, thread, status).
- Labels, priorities, assignees, search.
- Email or Slack notifications.
