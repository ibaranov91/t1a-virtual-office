# Arcade party pack: Break Set, seven versus games, a game table — design

Owner: Andrii Butko · 2026-10-16 · status: v2, after a Codex spec review · builds on
`2026-10-15-arcade-deck-park-design.md` (cabinets, sessions, server-sequenced inputs, rollback `Runner`, balcony,
records). Only what changes is written here.

## Why

Andrii's verdict on Deck Park after playing it on prod: the levels are boring, too easy and all alike, there is no
competition like in Cuphead, and there is no way to name a team. Decisions taken with him:

- **Competition first**: a short session format with points, a final round, awards, crew names and weekly boards
  ("Break Set").
- **Versus games**, several genres, short rounds. Playing as your Deck avatar is fine but not required.
- **Classic table games** at a game table: chess, checkers (шашки), dominoes and an UNO-style card game.
- **Deck Park stays** as the co-op mode and as one card in the Break Set playlist.

Built in one pass; section 14 orders the work in three full-stack steps, each leaving the app playable.

## Out of scope

- Bots/AI opponents in the shipped game (scripted bots only inside tests).
- Ratings (Elo/TrueSkill): weekly points, wins and awards only.
- New rooms or chairs: everything lives in the existing Arcade; the table is one object.
- The UNO name and art (Mattel's trademark): the card game is **"Last Card"** with UNO-like rules and our own art.

## 1. Game definitions

Everything that runs inside a cabinet session is a **game definition** picked per epoch. Sessions, epochs, input
sequencing, rollback, `game_check`, balcony and spectator delay work exactly as today.

```ts
// shared/arcade/types.ts
export type GameId = 'hub' | 'vote' | 'park' | 'quiver' | 'screenrun' | 'volley' | 'crumble' | 'crown' | 'trails' | 'skylanes';
export interface RosterEntry { slot: number; userId: string; team: 0 | 1 | null }
export interface BaseState { frame: number; fx: Fx[]; outcome: Outcome | null }   // every game state extends this
export interface Fx { frame: number; kind: string; slot: number }
export interface Outcome { order: number[][]; stats: Record<number, Stats>; signal?: unknown } // slots, best group first
export type StatKey = 'kills' | 'deaths' | 'falls' | 'stomped' | 'stomps' | 'airFrames' | 'distance' | 'holdFrames'
  | 'coins' | 'steals' | 'points' | 'height' | 'tiles' | 'survivedFrames' | 'shoves' | 'spikes' | 'personal';
export type Stats = Partial<Record<StatKey, number>>;
export interface GameDef<S extends BaseState, O = unknown> {
  id: GameId; name: string; goal: string; controls: ('move' | 'aim' | 'jump' | 'action')[];
  players: [min: number, max: number];
  modes: { ffa: number[]; teams: boolean };          // player counts allowed in FFA; 2v2 support (4 players only)
  init(seed: number, roster: RosterEntry[], opts: O): S;
  step(s: S, events: GameEvent[]): void;             // one frame
  bits(s: S, slot: number): number;                  // the slot's current buttons (Runner uses it after a snapshot)
}
```

- **State**: a plain JSON-serializable object (Runner snapshots it with `structuredClone`) extending `BaseState`.
  `fx` is rewritten every step and not hashed. `hash(s)` is a generic FNV-1a walk over the state in sorted key order,
  skipping `fx` (`shared/arcade/hash.ts`), so games don't hand-write hash lists.
- **Events** (log order, start of the frame): join → the slot appears per game rules with no buttons; leave → the slot
  is removed and, in a running versus game, counts as eliminated now (last among those still in); reset (kind 3) →
  clears the slot's buttons and edge state only (no respawn, scores untouched); input → sets buttons.
- **Terminal state**: once `outcome` is set, a step applies events and does `frame += 1`, nothing else; `outcome` never
  changes again. The server reads `outcome` from its confirmed sim exactly once per epoch.
- **Determinism**: integer sub-pixels, `Math.trunc` for every division, no floats, trig, `Math.random`, `Date`;
  mulberry32 PRNG state inside `S`; arrays in fixed order. Fractions are integer ratios written in the spec below.
- **Hard caps**: every game sets `outcome` by its time cap at the latest.
- `shared/arcade/registry.ts`: `GameId → GameDef`. Deck Park is wrapped as `park` (opts `{ level, card: boolean }`),
  its lobby as `hub`. Games not built yet are simply absent from the registry (never offered).
- **Input bits** grow to six: `1` left, `2` right, `4` up, `8` down, `16` jump, `32` action (`bits & 63`).
  Keyboard: arrows / WASD move; jump **Space, Z or J**; action **X, K or Shift**. In Deck Park and the hub, up (`4`) also
  jumps, as today. Push-to-talk keeps Space. Gamepad: d-pad/stick, A jump, B/X action. Touch: ◀ ▶ ▲ ▼ Jump Action.
- **Player identity**: slot colours with a shape marker under the name tag (red ▲, blue ●, green ■, yellow ◆). Avatars
  everywhere except Trails (light bikes in the slot colour).

## 2. Sessions, screens and snapshots

An epoch is either a **simulation** (hub, vote, a round) or a **screen** (title, scores, bonus, awards) with no inputs.

```ts
export type SessionView =
  | { kind: 'sim'; game: GameId; seed: number; opts: unknown; roster: RosterEntry[]; startAt: number; snapshot: BaseState; events: GameEvent[] }
  | { kind: 'screen'; screen: 'title' | 'scores' | 'bonus' | 'awards'; until: number; data: ScreenData };
export interface PublicSession {
  cabinet: string; epoch: number; serverNow: number; players: GameMember[]; spectators: string[];
  crew: { key: string; name: string }; view: SessionView; set: PublicBreakSet | null;
}
```

- `game_session` carries the whole thing and is sent on join, on every new epoch, on owner change, reconnect and
  `game_sync` — so a page that reloads mid-screen or mid-round lands in the right place.
- Inputs are accepted only in `sim` epochs; `game_input` for a screen epoch is ignored.
- Epoch seeds are fresh server randomness per epoch (public). The set's secret bonus category is never in a public
  message before its reveal.
- Spectators keep their 150 ms delay: screens and new epochs are applied 150 ms after arrival on spectator pages.
- **Menu during a Break Set**: only "Leave". `game_menu` restart/lobby is refused server-side while a set runs; outside
  a set (co-op Deck Park) it works as today.

## 3. The hub

The lobby level becomes the hub of a cabinet (same room, EXIT door, ◀ ▶ level blocks):

- **PARTY pad** left of centre, **CO-OP pad** right of centre (each 3 tiles), each with a hold bar. Everyone present
  standing on the same pad for 60 frames → `outcome.signal = { start: 'party' | 'coop', level, teamMode }`. PARTY needs
  2–4 players; with 1 present it is drawn greyed with "2+ players" and never fills.
- **Crew sign** (bumpable block over the middle): each bump increments `state.crewBumps`; the server rerolls the crew
  name once per increment it sees in its confirmed sim (it remembers the last count it handled).
- **Mode block** (drawn only with exactly 4 present): bump toggles `state.teamMode` (FFA ↔ 2v2).
- **EXIT door**: as today; the server lets a player go when their slot is `entered`.
- The hub draws the crew name, the mode, and the selected co-op level with its record.

## 4. Break Set

```ts
interface BreakSet {                 // server only
  id: string; round: 1 | 2 | 3; mode: 'ffa' | '2v2';
  players: { userId: string; slot: number; team: 0 | 1 | null; left: boolean }[];
  points: Record<string, number>; rounds: RoundResult[]; played: GameId[];
  bonus: StatKey[];                  // secret: the category order for the bonus star (section 4.4)
  predictions: Record<string, string>; favourite: Record<string, string>;
}
export interface PublicBreakSet {    // what clients see
  id: string; round: number; mode: 'ffa' | '2v2';
  players: { userId: string; slot: number; team: 0 | 1 | null; left: boolean }[];
  points: Record<string, number>; rounds: PublicRoundResult[];
}
export interface PublicRoundResult { game: GameId; order: string[][]; points: Record<string, number>; underdog: string[]; final: boolean }
```

### 4.1 Flow
1. **Vote** (`vote` game, exactly 480 frames): three cards — two distinct games picked at random among the eligible
   ones (section 4.3) that are not among the set's last two played, plus **Surprise** (a random eligible game that is
   not one of the two shown and not among the last two). Each player moves a cursor ← → and confirms with jump; they can
   change until the end; the vote always runs the full 8 s. At frame 480: the card with the most confirmed votes; ties
   and no votes → the PRNG picks among the tied cards (all three with no votes). Spectators predict the round winner
   in the same 8 s (`game_predict`, one per spectator, last one counts).
2. **Title** screen (3 s): name, one-line goal, control icons, "Round 2/3", "FINAL ×2" on round 3.
3. **Round**: the game's epoch with `{ seed, roster, opts: { mode } }` until its outcome.
4. **Scores** screen (6 s): places, points, underdog, correct predictions, totals.
5. After round 3's scores, a **favourite** screen (8 s) when ≥ 2 eligible spectators, then **Bonus** (3 s), then
   **Awards** (10 s), then one board commit (section 6), then back to the hub.

### 4.2 Points
`placePoints(n)` for n players in the round: 4 → `[3,2,1,0]`, 3 → `[3,1,0]`, 2 → `[3,0]`. A place group of k tied
players starting at place p gets `placePoints(n)[p]` each. Example, 4 players, groups `[[a,b],[c],[d]]` → a 3, b 3,
c 1, d 0.

- 2v2: the outcome is two groups (teams), or one group for a draw → winners 3 each, losers 0; a draw → 3 each.
- **Final**: round 3's place points ×2. Nothing else is doubled.
- **Underdog**: +1 to a player who was alone in the last group of the previous round and is now in the top half:
  place index < `Math.trunc(n / 2)` (n = 4 → places 1–2; n = 3 → place 1; n = 2 → place 1).
- **Park card**: +1 to everyone if the level was cleared (not doubled).
- **Leavers**: a player who leaves is out of the current round as eliminated-now and out of later rounds; they keep
  their points in the history but have no standing and get nothing on the boards. A reconnect within the existing door
  grace is not a leave. If fewer than 2 players remain, the set ends at once with no board commit. In 2v2, if the
  roster stops being 4, the remaining rounds are FFA.
- **Joiners** during a set watch and play from the next hub.
- **Standings**: by points; ties by round-3 place; still tied → shared.

### 4.3 Eligibility
| Game | FFA counts | 2v2 | Team rule |
|---|---|---|---|
| quiver | 2–4 | yes | last team with someone alive wins the heat; no friendly fire |
| screenrun | 2–4 | yes | last team with someone in wins the heat |
| volley | 2 | yes | sides |
| crumble | 2–4 | yes | last team standing |
| crown | 2–4 | yes | team hold time = sum |
| trails | 2–4 | yes | points to a team when every bike of the other team is out |
| skylanes | 2–4 | yes | sum of best heights |
| park | 1–4 | no | — |

### 4.4 Bonus star
At the set's start the server shuffles the curated pool `['airFrames', 'kills', 'distance', 'height', 'holdFrames',
'coins', 'steals', 'spikes', 'tiles', 'stomps']` with the set seed (secret). At the reveal it takes the first category
whose highest total over the set's rounds is > 0 among players with a standing; those players (ties: all) get +2,
shown as e.g. "Most airtime: Ivan +2". None qualifies → no star.

### 4.5 Order at the end
favourite (+1 each to the most-voted participants; eligible voters: spectators present when the screen starts who are
not set participants; one vote each; abstaining is fine; ties → all tied) → bonus star → final standings → awards →
board commit (once, keyed by set id).

## 5. Awards

Computed after standings are final. Each award has a stat and a "best" direction; it goes to the single best player
whose value is > 0 (ties: the higher standing, then lower slot); a player holds at most two — if the best already has
two, the award goes to the next best; categories nobody qualifies for are skipped. Then **Consolation Prize** for
anyone without an award.

| Award | Value |
|---|---|
| MVP | set points |
| Sharpshooter | kills |
| Most Reckless | deaths + falls |
| Frequent Flyer | airFrames |
| Hoarder | coins + holdFrames / 60 (trunc) |
| Doormat | stomped |
| First Out | rounds finished alone in the last group |
| Comeback Kid | underdog bonuses |
| Steak in Mouth | 1 if led (alone) before round 3 and did not finish first |
| Photo Finish | 1 if won by ≤ 1 point |
| Consolation Prize | — |

`awards(set): Record<userId, AwardId[]>` is pure and unit-tested.

## 6. Crews, names, weekly boards

- **Crew** = the players present in a cabinet; key `JSON.stringify(sortedUserIds)`; name stored in `arcade.crews`
  (`{ [key]: name }`) and snapshotted into the set at its start (renames and leavers never rewrite history).
- **Auto names**: adjective + plural noun from two lists of 40 office-flavoured words ("Feral Staplers", "Quantum
  Interns", "Sleepy Spreadsheets", "Turbo Ficuses"), indexed by a hash of the key (+ the reroll count).
- **Reroll**: bump the crew sign. **Edit**: ✏ by the crew name in the overlay header → `crew_name { name }`: 1–20
  characters of letters (any script), digits, spaces and `-'!&.`, trimmed; a short blocklist; only from a player in
  the hub phase.
- **2v2 teams**: red/blue, balanced by this week's points (1st + 4th vs 2nd + 3rd; no points → slot order), shown as
  "<crew> · Red / Blue".
- **Weeks**: Monday 00:00 Europe/Warsaw. Week key = the Warsaw-local date of that Monday, computed with
  `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', … }).formatToParts()` (no fixed 168-hour arithmetic). A
  result belongs to the week in which it was committed. Rollover happens lazily on the first read or write in a new
  week: the old week's #1 goes to the hall.
- **Storage** (`state.json` → `arcade`, all fields optional so old saves load unchanged):
  ```ts
  { records,                                   // Deck Park, unchanged; new records also store `crew?: string`
    crews: Record<string, string>,
    week: { key: string;
            players: Record<userId, { name: string; sets: { id: string; total: number }[] }>;   // best 10 kept
            champions: Record<GameId, Record<userId, number>>;   // round wins (every member of a first group)
            oracle: Record<userId, number>;                      // correct predictions
            table: Record<TableGameId, Record<userId, number>> }; // table wins
    hall: { week: string; userId: string; name: string; points: number }[] }   // last 10
  ```
  Ranks: ties share a rank. Aborted sets write nothing (no champions, no oracle).
- **Boards** (the records board becomes "Arcade boards", popover with tabs): **This week** (sum of best 10 set totals),
  **Champions** ("King of Quiver" per game), **Oracle**, **Table**, **Deck Park** (records with crew), **Hall of Fame**.
  `arcade_boards { boards }` replaces `arcade_records`, sent on connect and after each commit.

## 7. The versus games

View 320×192 at 60 fps. Shared side-view helpers in `shared/arcade/arena.ts`: tile collision against a 20×12 grid,
run/jump with Deck Park's constants (RUN_MAX 32, JUMP_V 92, gravity 6/10, MAX_FALL 88 sub/frame), one-way platforms,
optional wrap-around, 1-px swept movement (so no dash tunnels through walls). Each arena game ships 3 layouts chosen by
the seed. "Heat" = an inner round; a match is several heats.

### 7.1 Quiver (TowerFall-style archers)
- Arena wraps left↔right; top↔bottom wraps until the spikes start.
- Each player: 3 arrows (max 6). **Action** fires in the held direction (8 ways; none → facing): speed 96 sub/frame on
  axes, 64 sub/frame per axis diagonally; cooldown 12 frames. An arrow flies until it hits a wall/floor (sticks) —
  stuck arrows are picked up by anyone touching them. Arrows kill on touch, except the shooter's own arrow for its first
  10 frames and teammates in 2v2. **Landing on a head** (falling, feet in the top half) kills.
- Heat: ends when ≤ 1 player (FFA) / team (2v2) has someone alive → that one gets 1 heat point; all dead in the same
  frame → nobody. At 40 s into a heat spikes rise from the bottom by 1 px every 4 frames (touch = death, no vertical
  wrap from then on); heat cap 60 s → no point. A new heat resets positions and arrows.
- Match: first to **3** heat points; cap 150 s → order by heat points, then kills. Stats: kills, deaths, stomped, stomps,
  airFrames.

### 7.2 Screen Run (SpeedRunners-style race)
- Course: seeded sequence of 20-column chunks from 12 templates; every template is entered and left at floor row 10
  with solid ground at its edges, and each template is **validated in a test** by a reference bot (hold right, jump at
  the last floor tile before a gap or a 1–2 tile step) that crosses it.
- Camera: `camX = max(camX, leaderX − 120 px)`, plus an auto-scroll that starts at 3 s with 16 sub/frame and grows by
  4 sub/frame every 10 s up to 48. Out: left of `camX`, or falling below the screen.
- **Action**: dash — 96 sub/frame for 8 frames (swept), cooldown 120 frames; a player you touch while dashing gets
  +80 sub/frame horizontal push for 8 frames.
- Heat: last one in (team: last team) gets 1 point; simultaneous outs → no point; heat cap 60 s → the leader.
  Match: first to **3**, cap 150 s → points, then total distance. Stats: distance, falls, shoves.

### 7.3 Office Volley (Slime-Volleyball-style)
- 1v1 or 2v2 only. Court: floor, net at x 160 (height 48 px), walls.
- Ball: radius-free 8×8 box, gravity 4 sub/frame², max speed 128 sub/frame. Hitting a player: `vy = −112`, `vx =
  (ballCentre − playerCentre) × 6` (sub/frame, clamped ±112). **Action in the air** while touching = spike:
  `vy = +96`, `vx = ±128` toward the other side. Max 3 touches per side; the 4th touch is a point for the other side.
- Point: ball touches the floor on a side. Serve from the side that lost the point.
- First to **7**; at 90 s the leader wins; tied at 90 s → golden point up to 120 s; still tied → draw.
  Stats: points (last toucher of a scoring ball), spikes.

### 7.4 Crumble Tower (Hex-A-Gone-style)
- Floors on rows 2, 5, 8 and 11, columns 1–18; players spawn spread on the top floor.
- A tile touched by a standing player cracks and disappears 30 frames later (still solid while cracked).
- **Action in the air** = ground-pound: `vy = MAX_FALL` until landing, then the tile under the player's centre and its
  left and right neighbours vanish at once; usable again after landing.
- Out: below row 12. Last one (team) standing; same-frame eliminations share a group; cap 90 s → survivors share first.
  Stats: tiles (tiles you broke), falls, survivedFrames.

### 7.5 Crown Keep-Away (golden stapler)
- Arena with platforms; the stapler spawns in the middle. Touching it takes it; the holder's `holdFrames` grows each
  frame; holder speed `Math.trunc(RUN_MAX × 85 / 100)`, can't tackle.
- **Action**: tackle dash in the facing direction, 80 sub/frame for 10 frames, cooldown 45. Touching the holder while
  dashing steals it; the old holder is stunned 30 frames; the new holder can't be robbed for 30 frames. Several
  tacklers in one frame → lowest slot.
- Stapler falling into a pit or its holder leaving → it drops/returns to the middle after 60 frames.
- Win: **20 s** of holding (1200 frames) — team: summed; cap 90 s → order by hold time. Stats: holdFrames, steals.

### 7.6 Trails (Tron-style light bikes)
- Grid 64×38 cells of 5 px. All bikes move **in the same tick**, one cell every 3 frames (boost: every 2). Arrows queue a
  turn applied at the next move (no reversing). Boost meter 90 frames, drains 1/frame while boosting, refills 1 per 2
  frames.
- **Jump**: the next move skips one cell (no trail there) and lands two cells ahead; cooldown 180 frames.
- After every tick: a bike whose new cell is a border, any trail (including cells entered this tick by others), or the
  same cell as another bike, or that swapped cells with another bike → out. All outs in one tick share a group.
- Heat ends when ≤ 1 bike (team) is left; +1 point to each survivor per opponent who went out in that heat; heat cap
  30 s. Match: first to **6**, cap 150 s. Stats: survivedFrames, deaths.

### 7.7 Sky Lanes (Doodle Jump, separate lanes)
- Every lane is **80 px wide** (logical, any player count); lanes are drawn side by side and centred. Identical seeded
  platform columns in every lane; each lane scrolls on its own.
- Player: auto-bounce `vy = −104` sub/frame on landing on a platform from above, gravity 4 sub/frame², ← → steer
  (accel 4, max 40), wraps within the lane. Platforms: normal (24 px), moving (±24 px, 8 sub/frame), breaking (one
  bounce, never two in a row), spring (`vy = −160`). Vertical gap between platforms 24–64 px (always reachable).
- Camera per lane: rises with the player above the top third; from 5 s it also auto-rises at 4 sub/frame, +4 every
  15 s up to 16. Out: falling below your lane's view (your best height stays).
- Round: 90 s or everyone out. Order: by best height (team: sum). Stats: height, airFrames.

### 7.8 Deck Park (co-op card)
- A seeded random level among 1–8, 120 s cap. Park state gains hashed per-slot counters `coins`, `stomps`, `deaths`
  and `keyDoor` (1 for the slot that carried the key into the door). Personal score = coins + 2·stomps + 5·keyDoor −
  2·deaths. Outcome: order by personal score (ties shared), `signal: { cleared }`. A card run never writes Deck Park
  records; only standalone co-op runs do.

### Tests per game
Determinism (same events → same hash), rollback with delayed inputs, and seeded **scripted bots** that play 2, 3 and 4
players (and 2v2 where allowed): every match reaches `outcome` before its cap with every present slot exactly once in
`order`.

## 8. The game table (turn-based, server-authoritative)

- One new fixture: `game_table` (2×1, not walkable) at (58,17) on the teal rug, `use: { kind: 'table', label: 'Game
  table' }`, in `KEEP_TYPES` (so `withNewFixtures` adds it to saved layouts), and `layoutProblem` requires a reachable
  neighbour like the cabinets. No chairs.
- Clicking it walks you next to it (same stand-spot rule as cabinets) and adds you to the table as a **sitter** (max 4,
  in join order); more people → watchers. Joining the table leaves any cabinet session and vice versa; walk, meeting,
  layout step-aside and the door flow leave the table, like cabinets. Table messages go through the owner socket.
- **Host** = the earliest sitter; leaves → the next one.
- **Match**: the host picks Chess / Checkers (2 sitters) or Dominoes / Last Card (2–4) and presses Start when the count
  fits; the roster is frozen at start; later sitters watch until the next match. Rematch: the host starts again.
- **Moves**: `table_move { matchId, revision, move }`; the server applies a move only if `revision` equals its current
  revision and it's that player's turn (or a free action like Catch!), then `revision += 1`. Every recipient gets
  `table { view }` with only their own hidden information (hands), the public state, `revision`, `turnDeadline` and
  `serverNow`.
- **Clock**: 2 min per turn. Expiry is checked before every move. 2 players → the one who timed out loses. 3–4 players →
  an automatic action (Last Card: draw 1 and pass; Dominoes: draw if possible, else pass); two consecutive timeouts →
  that player forfeits. Invalid moves, draw offers and reconnects never reset the clock.
- **Leaving mid-match**: 2 players → the other wins. 3–4 → the leaver is out; their hand stays out of play (private,
  never reshuffled); if one active player is left, they win.
- Results: wins go to the weekly **Table** board; draws give nothing.

### Rules (pure modules in `shared/table/`, unit-tested)
- **Chess** (`chess.js`, pinned version, root runtime dependency): the server keeps the match as the full move list and
  rebuilds a `Chess` instance from the start position for every check (never from a client). Automatic end: mate,
  stalemate, insufficient material, threefold repetition, 50-move rule (draws). Promotion picker. Resign any time.
  Draw offer stands until the opponent moves or answers.
- **Checkers** (Russian draughts, FMJD-64): 8×8 dark squares, white starts; men move one step diagonally forward and
  capture forward and backward; kings fly (any distance) and capture at any distance landing on any free square beyond.
  Capturing is mandatory, and a capture must be continued while possible; any capturing sequence may be chosen (not
  necessarily the longest). A move is the full list of landing squares; captured pieces are removed after the move and
  can't be jumped twice. A man that reaches the last row during a capture becomes a king and continues as one.
  Win: the opponent has no pieces or no legal move. Draw: the same position with the same side to move for the third
  time, or 15 moves each with only kings and no capture, or agreement.
- **Dominoes** (double-six, 28 tiles): 7 each; boneyard 14 (2 players), 7 (3), none (4). The holder of the highest double
  starts with it (no double dealt → the highest tile). On your turn play a tile matching either open end; if you can't,
  draw one at a time until you can (and must) play, or the boneyard is empty → pass. Doubles are drawn crosswise, no
  spinners. Win: empty hand. Blocked (every active player passed in a row with an empty boneyard): the lowest pip total
  wins; tie → draw.
- **Last Card**: 108 cards — per colour (red, yellow, green, blue) one 0, two each of 1–9, Skip, Reverse and Draw Two;
  plus 4 Wild and 4 Wild Draw Four. 7 each. The first discard is turned over until it is a number card. On your turn
  play a card matching colour or symbol, or any Wild (Wild Draw Four is always allowed; no challenge), choosing a colour
  for wilds; or draw one card — if it's playable you may play it at once, otherwise the turn passes. Skip: next player
  loses their turn. Reverse: direction flips (2 players: acts as Skip). Draw Two / Wild Draw Four: the next player draws
  2 / 4 and loses their turn. No stacking. Empty draw pile → the discards except the top are shuffled back. **Last
  card**: the play command that leaves you with one card carries `lastCard: true`; without it, any other player may
  send `catch` until the next accepted action → you draw 2. Win: empty hand (the last card's effect doesn't matter).

UI: an overlay like the cabinet's but mouse-first (click a piece/tile/card, then the target; a colour picker for
wilds; buttons Last card! / Catch! / Draw / Pass / Offer draw / Resign). Pixel-art board and pieces; dominoes and cards
drawn on canvas with the pixel font.

## 9. Spectators

As today (balcony, cheers), plus predictions during the vote (correct = the predicted player is in the round's first
group) and the favourite vote. Set participants who leave and watch get neither. At the table, watchers see the public
view.

## 10. In the office

Bubbles and tooltips: "Playing Quiver · round 2/3 with Ivan", "At the game table · Chess with Varya", "Watching …";
cabinets glow as now; the table shows a tiny board while a match runs; the board label is "Arcade boards".

## 11. Protocol (`shared/protocol.ts`)

`PublicSession` as in section 2 (replaces the Deck Park-only shape). New/changed messages:

```ts
ServerMsg +=
  | { t: 'table'; view: TableView | null }                        // per recipient
  | { t: 'arcade_boards'; boards: ArcadeBoards }                  // replaces arcade_records
ClientMsg +=
  | { t: 'crew_name'; name: string }
  | { t: 'game_predict'; epoch: number; userId: string }
  | { t: 'game_favourite'; epoch: number; userId: string }
  | { t: 'table_pick'; game: TableGameId } | { t: 'table_start' }
  | { t: 'table_move'; matchId: string; revision: number; move: unknown }
  | { t: 'table_resign'; matchId: string } | { t: 'table_draw'; matchId: string; offer: boolean } | { t: 'table_leave' }
ObjectUse += { kind: 'table'; label: string }
```
`game_*`, `crew_name` and `table_*` from non-owner sockets are ignored.

## 12. Persistence and migration

All new `state.json` fields are optional; a save without them loads as today (existing `arcade.records` untouched;
old records have no `crew`). The game table reaches saved layouts through `withNewFixtures` (it is a keep-type
fixture); nothing else in saved layouts changes.

## 13. Tests (beyond per-game tests)

- **Orchestration harness** (extends today's delayed-transport `Arcade` + `Runner` test): hub → vote → title → round →
  scores ×3 → favourite → bonus → awards → hub with 2, 3 and 4 players and 2v2, including an owner change, a player
  leaving mid-round, a reconnect during each screen, a spectator joining mid-set; every runner's state hashes equal to
  the server's at common frames; boards committed exactly once.
- **Scoring/awards/bonus/weeks**: pure-function tests with the examples above; week keys across a DST change.
- **Table**: each rules module (legal moves, captures, draws, end conditions; Last Card specials and catch); server
  table sessions: hidden hands never reach other recipients, revision rejects duplicates, timeouts handled exactly once,
  leaving rules; `chess.js` imported under `tsx` and in the Vite build.

## 14. Implementation steps (one executor at a time; each leaves the app playable)

1. **Framework + Break Set + first games**: sections 1–6, 9, 11–13 (minus the table), `hub`, `vote`, `park` card,
   **Crumble Tower** and **Crown Keep-Away** with renderers, all Break Set screens and UI (title, vote, scores,
   favourite, bonus, awards, predictions, crew edit), boards popover, sounds/art for them. A Break Set is fully
   playable with three cards (crumble, crown, park).
2. **More games**: Quiver, Screen Run, Office Volley, Trails, Sky Lanes — rules, tests, renderers, art, sounds.
3. **Game table**: fixture, `server/src/table.ts`, the four rules modules (+ `chess.js`), table overlay UI and art, tests.

After each step: `npm test`, `npm run typecheck`, `npm run build -w client`, and a muted headless browser check.
