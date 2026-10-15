# AGENTS.md: working on The Deck

The Deck is a cozy pixel-art virtual office for T1A (~30 people, fully remote). Each person is a sprite on
one shared floor. You walk by clicking, knock on someone to start a voice call, and see who's around at a
glance. Product intent and design rules are in `REQUIREMENTS.md`; read it before adding features.
Hackathon project: favor small, working, demo-able steps.

## Layout
- `shared/`: code and data used by both sides. `map.ts` (A* pathfinding, rooms, seats), `protocol.ts`
  (every WebSocket message), `tilemap.json` (generated, don't hand-edit).
- `server/src/`: Node + `ws`, one process, state in memory, saved to `data/state.json` every 30 s.
  `world.ts` holds users, moves, knocks, calls, desks and the door. `bots.ts` holds dev bots. `index.ts` does
  REST, login, static files and WebSocket.
- `client/src/`: React only for chrome (`App.tsx`). The floor is one `<canvas>` (`engine.ts`).
  `net.ts` is the store plus the WebSocket client, `voice.ts` is WebRTC voice, `sounds.ts` is synthesized UI sounds.
- `macos/`: the menu bar app (Swift, AppKit + WKWebView). See "macOS app" below.
- `scripts/`: `gen-map.mjs` (writes `shared/tilemap.json`), `gen-assets.mjs` (writes `client/public/assets/*`),
  `deploy.sh` and `instances.txt`.
- The art is procedural placeholder art. Run `npm run gen` after changing either generator, and commit the regenerated files.

## Running locally
```bash
npm install
npm run dev          # http://localhost:5173 (API on 127.0.0.1:8787, reached through Vite's proxy)
npm run dev:mesh     # also on this machine's NordVPN Meshnet IP over self-signed HTTPS (for other devices + mic)
npm run typecheck    # run before every commit or deploy
```
- In dev you're signed in automatically as `Dev`. Use `?as=Kim` for another person, for example a second tab.
- `BOTS=0` disables bots, and `BOT_COUNT` sets how many (default 4). Bots only knock on other bots, never on people.
- `VITE_PORT` / `DECK_PORT` run a second copy beside the first. Port 5174 may be held by another worktree's
  session, so leave other sessions' processes alone and pick a free port.
- Debug handles exist in dev only: `window.__deck` = `{ store, engine }` and `window.__voice`.
  `engine.setZoom(n)` and `engine.focusUser(id)` help with screenshots. `store.knock(id)` and
  `store.replyKnock(id, 'accept')` drive the knock flow without clicking.

## How things work (the parts that bite)
- **Server is the source of truth.** Clients send intents (`move`, `knock`, …). The server broadcasts
  events, and every client computes the same path from the same map (deterministic A*).
- **Mid-walk moves** start at the tile being entered, timed for arrival. Clients keep the previous walk until then.
- **Knocks → calls.** Accepting a knock puts both people in a call (`callId`). Others can knock their way in,
  except in the Meeting room, where knocks go to Later. A call ends when fewer than two people are left. Calls are
  in memory only, so a server restart drops them.
- **Voice** is an audio-only WebRTC mesh, capped at `MAX_CALL_SIZE` = 5. The server relays signaling only between
  members of the same call. The lower user id makes the offer. Signals carry `conn` (one attempt) and `inst` (one page)
  so stale offers or answers are dropped and reloads reconnect. If you touch this, re-test: two tabs, call, Leave,
  call again (must connect), and reload each side mid-call.
- **Talking bubbles** come from real mic activity (`speaking` messages). Bots fake turn-taking.
- **Private data never gets broadcast.** `email` and `meetLink` are stripped in `World.toPublic`. A Meet link
  goes only to the people in that knock or call.
- **Room behavior is data.** Knock rules, meeting links and home-desk rooms live in `tilemap.json`
  (from `gen-map.mjs`), not in code.

## macOS app
A menu bar app that hosts the normal web client in one WKWebView. Click the icon to open the window,
right-click for the menu: pin to desktop (a borderless window just above the desktop icons), arrange it,
pick the instance, pop up on knock. The web view moves between the window and the desktop, so it's one
page and one WebSocket. `client/src/native.ts` tells the app about knocks and calls (icon turns orange on a
knock), and does nothing in a normal browser.
```bash
macos/build.sh                    # → macos/build/The Deck.app (Command Line Tools are enough, no Xcode)
defaults write io.t1a.deck url "http://localhost:5173/?as=Mac"   # or pick an instance from the menu
```
- Not a WidgetKit widget on purpose: widgets can't run a web view, refresh at most every few minutes,
  and can't use the mic.
- Ad-hoc signed, so on another Mac it needs right-click → Open the first time. Web Inspector: Safari ▸ Develop.

## Testing tips and limits
- The Claude app's browser pane **blocks the microphone** and won't open self-signed HTTPS. It can still verify
  that voice *connects* (`__voice.connectedCount()`), since both sides fall back to listen-only and a data
  channel keeps the connection up. Real audio needs a person in two real browsers.
- **NordVPN Meshnet doesn't route a machine to its own Meshnet IP.** Test `dev:mesh` from another device, or use
  `https://localhost:5173` on the same machine.
- For server-only behavior, a tiny Node script with `ws` that logs in and talks to `ws://localhost:8787/ws` is
  quick and reliable. Run it from `server/` so `ws` resolves.

## Deploying
Several separate copies ("instances") run on the vOffice box (`ssh Hetzner2-vOffice`, NetBird IP
`10.200.142.211`), listed in `scripts/instances.txt`:

```
name   port   login   owner (GitHub)        URL
prod   8080   sso     ibaranov91            https://voffice.t1a.io
andr   8081   pin     booandrew             https://voffice-andr.pub.t1a.cloud
var    8082   pin     varvaratikhonova-ui   https://voffice-var.pub.t1a.cloud
iva    8083   pin     ibaranov91            https://voffice-iva.pub.t1a.cloud
```

```bash
scripts/deploy.sh <name>   # no argument = prod. Deploys your WORKING COPY (uncommitted changes included)
```
- Each instance is fully separate: `/opt/deck-<name>`, its own `data/`, `/etc/deck-<name>.env` and
  `deck-<name>.service`. Prod uses `/opt/the-deck`, `/etc/the-deck.env` and `the-deck.service`. The script locks
  per instance, refuses a port that's already in use, and prints the URL. Set `DECK_SSH_HOST` if your ssh alias differs.
- **Login mode** (column 3) is re-applied on every deploy:
  - `sso`: NetBird sign-in. The NetBird proxy entry must use NetBird SSO so it sends `X-NetBird-User`. The server
    trusts that header only from `NETBIRD_TRUSTED_CIDR` *and* a caller whose NetBird name looks like the proxy (`NETBIRD_TRUSTED_PEER`).
  - `pin`: a public `*.pub.t1a.cloud` entry behind a NetBird PIN. Pick any name, no password (`OPEN_LOGIN=true`).
    NetBird sign-in can't work there.
- **New instance:** pick the next free port, add a line to `instances.txt`, have someone add a NetBird reverse-proxy
  entry to `http://10.200.142.211:<port>`, then deploy. Check that the proxy entry's port matches.
- **Only deploy to an instance when its owner asked you to.** Never deploy prod unless asked.
- **Check after a deploy:**
  ```bash
  ssh Hetzner2-vOffice 'systemctl is-active deck-<name>; curl -s http://10.200.142.211:<port>/api/config'
  ```
  Public `pin` URLs answer 401 (the PIN page) to curl. That's expected.
- **Logs:** `ssh Hetzner2-vOffice journalctl -u deck-<name> -f`.

## Conventions
- TypeScript strict, both sides. Match the surrounding style: compact, comments only where the *why* isn't obvious.
- Protocol changes go in `shared/protocol.ts` first. The server validates everything a client sends.
- Keep REQUIREMENTS.md's "not now" list in mind: design for it (data, not code), don't build it.
- Commit only when asked, and write descriptive messages. `main` is the shared branch, so pull before you push.
