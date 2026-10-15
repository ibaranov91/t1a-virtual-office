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
  `gen-music.mjs` (`npm run gen:music`, needs ffmpeg: the jukebox library from `scripts/music.json`), `deploy.sh`
  and `instances.txt`.
- The art is procedural placeholder art. Run `npm run gen` after changing either generator, and commit the regenerated files.

## Running locally
```bash
npm install
npm run dev          # http://localhost:5173 (API on 127.0.0.1:8787, reached through Vite's proxy)
npm run dev:mesh     # also on this machine's NordVPN Meshnet IP over self-signed HTTPS (for other devices + mic)
npm run typecheck    # run before every commit or deploy
```
- In dev you're signed in automatically as `Dev`. Use `?as=Kim` for another person, for example a second tab.
- Bots are opt-in: `npm run dev` turns them on (`BOTS=0` disables, `BOT_COUNT` sets how many, default 4), test
  instances have `BOTS=1`, and prod never has bots (deploy.sh removes the setting). Bots only knock on other bots, never on people.
- `VITE_PORT` / `DECK_PORT` run a second copy beside the first. Port 5174 may be held by another worktree's
  session, so leave other sessions' processes alone and pick a free port.
- Debug handles exist in dev only: `window.__deck` = `{ store, engine }` and `window.__voice`.
  `engine.setZoom(cssScale)`, `engine.toggleOverview()` and `engine.focusUser(id)` help with screenshots. `store.knock(id)` and
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
- **Private data never gets broadcast.** `email`, `meetLink` and `google` are stripped in `World.toPublic`. A Meet link
  goes only to the people in that knock or call.
- **Connect Google** (`server/src/google.ts`, **prod only**): OAuth with offline access, so a new knock call gets
  its own Meet room (Meet REST `spaces.create`, `accessType: TRUSTED`: anyone at t1a.com joins without asking).
  The call starts on the old link, and the new room arrives a moment later in a `call` message. The OAuth `state` says
  who started the sign-in, with no cookie needed, so the Mac app opens it in the system browser and its page hears
  back over the WebSocket. The Google account must match the NetBird email. Refresh tokens are AES-GCM encrypted with
  `GOOGLE_TOKEN_KEY` in `state.json`. Config lives only in `/etc/the-deck.env` (`GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY`, `GOOGLE_HD`; redirect `<DECK_PUBLIC_URL>/api/google/callback`). Copies are
  in 1Password, never in git. Without these vars (dev, test instances) the button is hidden and calls work as before.
- **Wall calendars** (Coffee, Co-working; `use.kind: 'calendar'` in `gen-map.mjs`): clicking one opens your own week
  from Google Calendar (`calendar` message, only to you). Calendar access (`calendar.events.readonly`) is asked for
  incrementally the first time, on the same sign-in. Never revoke a token when replacing it: that kills the whole grant.
- **Calendar meetings** (`server/src/meetings.ts`): every 2 min the server reads connected calendars for meetings with
  other people (now or within the hour) and merges them by event. One connected attendee is enough: everyone on the guest
  list (by sign-in email) gets an `agenda` (titles only to attendees), shows `meeting` (busy: knocks go to Later) and a
  heads-up a minute before with **Go** and the event's own call link. Go puts you in the meeting's **instance**: a copy
  of the Meeting room (same tiles), where only people with the same `instance` see each other; the office sees them on
  the board by the Meeting room and under "In meetings". No voice inside. Leave, or the meeting's end, puts you back
  where you were, still in the meeting (busy). The chip then offers **Rejoin** or **Leave meeting** (`meeting_out`): no longer
  busy, knocks come through again, Go puts you back in. Instances and who left live in memory only.
- **Zoom** is whole device pixels per art pixel (crisp; on Retina that includes 1.5×, 2.5×), glides 140 ms between levels
  and is remembered per device (`deck.zoom`). The lowest level fits the whole floor: the overview, with room tags and a
  "You" pin; when it's small, a tap zooms in instead of walking. Pinch, ⌘/ctrl-scroll, `+ − 0`, `M`. Phones and short
  windows (`COMPACT` in App.tsx, same media query in styles.css) get a thumb dock and bottom sheets instead of top-bar buttons.
- **Jukebox** (Music room, `server/src/jukebox.ts`): CC0 tracks only (license checked on the source page; add one
  with a line in `scripts/music.json` + `npm run gen:music`, which writes content-hashed files and `shared/music.json`).
  Playback is server state timed by the server clock; anyone standing in the room queues, pauses and skips (controls
  name the current `playId`, so stale clicks do nothing). Clients stream a track through one `<audio>` element into
  the soundscape and only while it's audible, so nobody outside the room downloads music. Static files support HTTP
  Range (`server/src/static.ts`), which media seeking needs. `npm run gen:music -- --force`
  re-encodes everything, and new content hashes add ~35 MB to git history each time, so use it only when the
  pipeline itself changes.
- **Arcade** (Deck Park): clicking one of the three cabinets walks you over and opens its 1–4-player session;
  later arrivals watch from the balcony, and the records board shows best runs by level and team size. The server
  sequences inputs; clients predict locally and roll back with the shared `Runner`. `npm test` includes the deterministic
  simulation and delayed-transport netcode harness; `scripts/park-replay.mjs <level> <team> [--every 30]` replays solutions.
- **Edit mode** (pencil in the top bar, admins only: `DECK_ADMINS`, emails, default `ivan.baranov@t1a.com`; `npm run dev`
  adds the name `dev`, and names only count for logins without an email). Admins drag furniture and rugs, add from the
  catalog (one of each generated type), recolor/resize rugs, Reset. Walls, floors and rooms stay as generated; the
  furniture and rugs are a `Layout` the server owns (`edit` → `layout` to everyone, saved in `state.json` once changed).
  `applyLayout` in `shared/map.ts` derives walkable tiles, chair facing, seats and plant slots from it; `layoutProblem`
  refuses anything that blocks a doorway, the way in, a seat or a coffee machine/lamp (the client runs the same check for
  the red/green ghost). Home desks follow their chair; people under new furniture step aside. A saved layout overrides
  `gen-map.mjs`'s furniture, so after changing the generator, Reset (or drop `layout` from `state.json`) to see it.
- **Dungeon:** one grid has two unconnected areas; `MAP.office` bounds the office camera, overview and edit mode.
  Only a human's own `move` ending on the garden hole can fall into `instance: 'dungeon'`; `walkSeq` cancels stale
  fall/key/door timers on any later walk or placement. The server owns key state and sends it only to its owner;
  client discovery resets per visit. Neither is persisted.
- **Creatures and cups** (`server/src/creatures.ts`, drawn by `client/src/creatures.ts`): a cat, a dog, a bat (October only)
  and the cleaner. Not users: their own `creatures`/`creature` messages, never in the people list, never knock. They run
  everywhere, prod included (`PETS=0` turns them off). Holding a coffee or tea, click a table tile to put the cup down
  (`cup_put`; at most `MAX_CUPS`, saved in `state.json`); the cleaner paths to settled cups, wipes, takes them away. Cups
  also vanish after 30 min. The ghost of Mazurkevich is client-only (night hours, or 3 min an hour); in dev,
  `__deck.engine.critters.summonGhost()` brings him out.
- **Room behavior is data.** Knock rules, meeting links and home-desk rooms live in `tilemap.json`
  (from `gen-map.mjs`), not in code.

## macOS app
A menu bar app that hosts the normal web client in one WKWebView. Click the icon for a popover (with
"open in a separate window"), right-click for the menu: pin to desktop (a borderless window just above the
desktop icons), arrange it, pick the instance. The web view moves between popover, window and desktop, so
it's one page and one WebSocket. `client/src/native.ts` tells the app about knocks and calls and exposes
`window.__deckNative.reply`; it does nothing in a normal browser. A knock shows a small native card under the
icon (Open / Later). You accept inside The Deck on purpose, so voice starts from a click in the page. When
you're away or already in a call a knock only flaps the icon orange.
```bash
macos/build.sh                    # → macos/build/The Deck.app (Command Line Tools are enough, no Xcode)
defaults write io.t1a.deck url "http://localhost:5173/?as=Mac"   # or pick an instance from the menu
```
- Not a WidgetKit widget on purpose: widgets can't run a web view, refresh at most every few minutes,
  and can't use the mic.
- Web Inspector: Safari ▸ Develop ▸ The Deck.
- The app icon (a pixel door) comes from `swift macos/make-icon.swift` → `macos/AppIcon.icns` (committed). The menu bar
  icon is a pixel person drawn in code (`Person.swift`): orange on a knock, green with waves in a call.
- The app sits in the Dock only while its window is open; closing the window leaves it in the menu bar.

**Distribution.** Every deploy from a Mac builds the app (`macos/build.sh --dist` → `macos/dist/`) and the
instance serves it. People install with one command, shown under "Mac app" in the top bar:
`curl -fsSL <instance>/api/mac/install.sh | bash`. curl doesn't quarantine downloads, so Gatekeeper never
blocks it. The command uses the public URL for `sso` instances and the NetBird address for `pin` ones (the PIN
page answers curl with 401); deploy.sh sets `DECK_PUBLIC_URL` / `DECK_INSTALL_URL` for that.
- **Updates:** the page passes `/api/mac` (build id + sha256) to the app on every connect. A different build
  installs itself when you're idle (not in a call, The Deck not in front), otherwise via the Update button.
  The app checks the sha256 and that the new app has the same signer, swaps itself and relaunches.
  The build id is a hash of the app's sources, so deploys without native changes don't update anything.
- **Signing:** `macos/make-cert.sh` creates the self-signed "T1A Deck" identity in `~/.deck-signing` (its own
  keychain). A stable signer keeps the mic permission across updates and lets updates verify the signer.
  **Everyone who deploys must use the same identity** (`make-cert.sh import <p12>`, never a new one), or
  installed apps refuse the update. Without it, or if the Mac build fails, deploy.sh keeps the signed app the
  instance already serves as long as the app's sources haven't changed (same build id), and stops if they have
  (`DECK_ALLOW_ADHOC=1` ships ad-hoc anyway). An instance serving an ad-hoc app (or none) just gets an ad-hoc
  build, and every update re-asks for the mic.
- Only a Mac can build the app; deploying from elsewhere ships the instance without it.
- **One app per instance.** prod's app is "The Deck" (`io.t1a.deck`); every other instance builds its own,
  e.g. "The Deck (iva)" (`io.t1a.deck.iva`), with its own settings and login and a small purple mark on its
  menu bar person. They install side by side, and each only updates from its own instance, so trying a
  branch on a test instance never touches the prod app. `macos/build.sh` alone makes a local build that
  never self-updates.
- **Unread messages:** a blue dot on the menu bar person and a count on the Dock icon (no bouncing).
  Clicking the person opens the oldest unread chat; the web top bar has the same as a 💬 N button.

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
- **Never work in `main` and never commit or push to it directly.** `main` is the shared branch. Before editing, pull
  `main` and branch off it (or use a worktree), then land changes through a pull request.
- Commit only when asked, and write descriptive messages.
