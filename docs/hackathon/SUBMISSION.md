# The Deck: hackathon submission

T1A Hackathon "Cyprus Odyssey", Fall 2026. Team **The Suitors**: Andrii Butko (captain), Ivan Baranov, Varya
Tikhonova. Category: Inside the Crew.

| Artifact | Where |
| --- | --- |
| Slides (8-bit, 14 slides) | [slides.pdf](slides.pdf), or [slides.html](slides.html) in a browser (self-contained, arrow keys to move) |
| Build log | [docs/BUILD-LOG.md](../BUILD-LOG.md): what landed when, who built what, how we worked |
| Write-up | this file, and the longer [README](../../README.md) |
| Feature map | [docs/FEATURES.md](../FEATURES.md): every feature with its code, tests and spec |
| Live | https://voffice.t1a.io (T1A sign-in), demo https://voffice-demo.pub.t1a.cloud (type any email) |
| Code | https://github.com/ibaranov91/t1a-virtual-office |

## The problem

T1A is about 30 people, fully remote. The office's ambient awareness is gone: nobody sees who is around, who is deep
in focus and who is free for a two-minute question. Every question becomes a scheduled call or a Slack message that
waits. Video tools show people only once a meeting has started, and chat status dots don't say "come over". The
small things that make a team feel like one, a coffee chat, a birthday, someone reading in the corner, have no place.

## What we built

A persistent pixel-art office in the browser and in a macOS menu bar app. Every teammate is a character on one shared
floor of 18 rooms.

- **Presence on a map.** Your character stands where you work. Click to walk. Status text, away, in a call, in a
  meeting and reading are all visible on the floor and in a Discord-style sidebar of rooms and people.
- **Knock to talk.** Click someone and knock. They get Accept / Later; Accept starts built-in voice (WebRTC) or a
  Google Meet room. Focus rooms block knocks, busy people get a Later list, and the Mac app shows a native knock card.
- **Rooms that behave like rooms.** Coffee, Music, Arcade and Book Club are open-voice: walk in and you are in the
  conversation. Sound fades with distance and is muffled by walls. Admins switch any room between Voice, Knock, Quiet
  and Busy live.
- **Calendar-aware.** Connect Google: wall calendars show your week, a heads-up a minute before a meeting puts you in
  a private copy of the Meeting room with the other guests, and each knock call gets its own Meet room. The Meeting
  room's wall screen shows PDF slides or a shared screen.
- **Who's away, at a glance.** Calendar absences put people on the beach or in the mountains with a 🌴 nameplate and
  a return date.
- **Places to be together.** A shared CC0 jukebox and Lofi TV, playable instruments, a Library where everyone sees
  you reading, a Book Club, lunch tables that are small voice rooms.
- **Play.** An arcade with a rollback-netcode co-op platformer, party games, Game Boy homebrew cabinets with
  server-verified scores, a game table with chess, draughts, dominoes and Last Card, achievements with a trophy screen.
- **Wellness.** The yoga mat on the terrace opens per-person reminders: drink water, stretch (it rotates exercises)
  and a Pomodoro timer, each on its own interval, stored on your device, with Mac notifications.
- **Office life.** A cat, a dog, a cleaner who takes away forgotten cups, hats, a reception bell, cocktails, a club
  with a dance floor, a hidden dungeon.

## How it works

One Node process is the source of truth. Clients send intents (`move`, `knock`, `use`), the server validates them and
broadcasts events, and every client computes the same A* path from the same map, so a walk is one message. Every
WebSocket message is a typed union in `shared/protocol.ts`. The floor is one `<canvas>`; React draws only the chrome.
The map, room rules and furniture are generated data (`scripts/gen-map.mjs`), and all art is procedural
(`scripts/gen-assets.mjs`). Voice is a peer-to-peer WebRTC mesh with signaling relayed by the server. Arcade games are
deterministic `GameDef`s with client prediction and rollback. State is a JSON file saved every 30 s with daily backups.
Sign-in is NetBird SSO on prod, a PIN on test instances, any email on the demo. Details: [README › How it
works](../../README.md#how-it-works) and [AGENTS.md](../../AGENTS.md).

## What is working

Everything above runs on prod and was used by the team during the hackathon in desktop browsers, on phones and in the
Mac app. 600+ automated tests cover world rules, calls, rooms, games, table rules, jukebox, vacations and layout
editing. `npm test`, `npm run typecheck` and `npm run build -w client` pass on `main`.

Known limits: voice is a mesh (5 per call, 12 speakers per room) and calls don't survive a restart; Google features
need OAuth credentials, so they run on prod only; away is manual, there is no idle detection; the Mac app is
self-signed; one process with in-memory state fits a 30-person company, not thousands.

## What comes next

- **Secret Santa** in December: a gift box on your desk, a name drawn from the team, a reveal party in the Lobby.
- **Birthday celebrations**: cake and balloons at the desk, a banner in the Lobby, a one-click "happy birthday" knock.
- **Seasonal areas and notices**: Halloween is in (the bat, the cursed floor), next winter décor, a skating pond, and
  an HR notice board for company news.
- **SecondStack Q&A robot** in the Library: ask it a question about T1A's knowledge base and it answers in a bubble.
- From the backlog: sign-in without NetBird, automatic away when the laptop sleeps, Slack status sync, a TURN relay
  and an SFU for larger calls.

## How to run

Needs Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Open http://localhost:5173. You are signed in as `Dev`; open `?as=Kim` in a second tab to be someone else and knock on
yourself. Bots walk around so the floor isn't empty (`BOTS=0` turns them off).

```bash
npm test                  # 600+ tests, about 45 s
npm run typecheck
npm run build -w client && npm start -w server   # one process on http://localhost:8787, token "deck"
macos/build.sh            # the menu bar app (Xcode Command Line Tools)
```

Google features need `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY` (see README › Configuration).
Deploying to the instances: `scripts/deploy.sh <name>`, prod only from the head of `main` ([AGENTS.md ›
Deploying](../../AGENTS.md#deploying)).

## Build log

Two days, Oct 15–16, 2026, from the kickoff token in the first commit to prod. Three people chose the features and wrote
or approved a spec for each bigger one; coding agents (Claude Code, Codex) wrote most of the code in parallel git
worktrees; over 150 pull requests were merged, each after tests, typecheck and a build. Prod always runs the head of
`main`, enforced by the deploy script. The hour-by-hour log is [docs/BUILD-LOG.md](../BUILD-LOG.md).
