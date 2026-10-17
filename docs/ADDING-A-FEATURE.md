# Adding a feature: where things go

Anchors are grep patterns (`rg -n '<pattern>' <file>`), not line numbers. `npm run where -- <thing>` finds a room,
object type, use.kind, object id or tile and lists the code that mentions it; for a use.kind it also ticks off the
wiring rows below. Positions and free space: [MAP.md](MAP.md).

## The pattern every recent feature follows

`gen-map.mjs` places it → `shared/map.ts` / `shared/protocol.ts` type it → `world.ts` owns the state → `net.ts` stores
what arrives → `engine.ts` draws it, `App.tsx` gives it buttons/panels → `gen-assets.mjs` draws its art → a
`server/src/<feature>.test.ts` drives `World` directly. Shared pure logic gets its own `shared/<feature>.ts`
(e.g. `shared/lunch.ts`), server-only state its own `server/src/<feature>.ts` (e.g. `library.ts`, `toilets.ts`).

## A clickable object (new `use.kind`)

| Step | File | Anchor |
| --- | --- | --- |
| 1. Add the kind to the union | shared/map.ts | `export type ObjectUse =` |
| 2. Route it (typecheck fails until you do) | shared/map.ts | `export const USE_KINDS =` |
| 3. Place the object (append at the very end, never in the middle: object ids are positional and saved layouts key on them) | scripts/gen-map.mjs | a new block after the last one (`// ---------- vacation: props appended after all existing objects`), before `const map = {`; end it with `for (… of objects.slice(first…)) catalog[t.type] ??= t;` like the blocks above it |
| 4a. No `wheel` flag: act on click | client/src/App.tsx | `e.onPick = p =>` (one `if (use?.kind === '…')` line) |
| 4b. `wheel` flag: wheel buttons | client/src/App.tsx | `} else if (o.use.kind === 'toggle') {` (ActionWheel branches) |
| 5a. `use` flag: server action on arrival | server/src/world.ts | `use(u: User, objectId` (and `USE_MS`) |
| 5b. Own intent instead | see "A new intent" | |
| 6. Hover tooltip (else `objectName(type)`) | client/src/engine.ts | `const what = retroTip \|\| instrumentTip \|\|` |
| 7. Display name for the type | shared/map.ts | `export const objectName` |
| 8. One of a kind? can't be removed in edit mode | shared/map.ts | `export const KEEP_TYPES` |
| 9. Art: frame named exactly like the type | scripts/gen-assets.mjs | see "A sprite" |
| 10. Animated/stateful frame | client/src/engine.ts | `toiletFrame(f.o.id)` (frame picker in the draw loop) |

**The old "three exclude lists" gotcha is gone:** App.tsx's ActionWheel, `World.use` and `layoutProblem` used to
each hard-code which kinds they skip. They now read `USE_KINDS` (`routes(use, 'wheel' | 'use' | 'reach')`), so a new
kind is one row there. App.tsx `e.onPick` still needs its own line for every non-wheel kind (each calls a different
store method).

## A new intent (client → server message)

| Step | File | Anchor |
| --- | --- | --- |
| 1. Message type | shared/protocol.ts | `export type ClientMsg =` (put a comment after it) |
| 2. Validate + dispatch (never trust fields: `String(…)`, `\| 0`, `!!`) | server/src/world.ts | `handle(u: User, msg: ClientMsg` → `switch` |
| 3. The method | server/src/world.ts | a `// ---------- <feature> ----------` block of its own |
| 4. Store method that sends it | client/src/net.ts | near `use(objectId: string` (one-liners `this.send({ t: … })`) |
| 5. Bots: don't let them use it unless intended | server/src/world.ts | `u.bot` checks (e.g. in `use(`) |
| 6. Test | server/src/<feature>.test.ts | copy the `people(t)` helper style from world.test.ts |

Server → client events: add to `export type ServerMsg =`, handle in net.ts `private onMessage(msg: ServerMsg)` → `switch (msg.t)`.
Only-to-you data goes through `this.sendTo(u.id, …)`, everyone through `this.broadcast(…)`.

## A per-person field (on `PublicUser`)

| Step | File | Anchor |
| --- | --- | --- |
| 1. Field (optional `?` keeps old saves and tests valid) | shared/protocol.ts | `export interface PublicUser` |
| 2. Private, server-only fields instead | server/src/world.ts | `export interface User extends PublicUser` + strip in `private toPublic` |
| 3. Default for loaded users | server/src/world.ts | `load(data` → `this.users.set(d.id, { ...d,` |
| 4. Saved across restarts? | server/src/world.ts | `dump()` → `users:` |
| 5. Setter that broadcasts (`{ t: '<field>', userId, … }`) | server/src/world.ts | e.g. `private setEating(` |
| 6. Apply it on clients | client/src/net.ts | `case 'eating':` |
| 7. Draw / describe it | client/src/engine.ts | `private drawSprite(` / `private drawOverlay(` / tooltip status near `u.eating ?` |
| 8. Busy → knocks go to Later | server/src/world.ts | `private laterWhy(to: User)` (add the condition and its label) |
| 9. Timed? expire it in the 250 ms tick | server/src/world.ts | `this.lunchTick(now)` in the constructor's `setInterval` |

Private data (email, links, inventory) never goes in `PublicUser`; send it in `{ t: 'me' }` (`case 'me':` in net.ts).

## An effect (buff, debuff, hat)

| Step | File | Anchor |
| --- | --- | --- |
| 1. Rule: who may set it, label, icon, duration | shared/effects.ts | `export const EFFECTS` |
| 2. Drawing (back/front layers) | client/src/effects.ts | `export const EFFECT_DRAW` |
| 3. Changes the look / sway / walk speed | client/src/effects.ts `effectLook`, `effectSway`; shared/effects.ts `walkMs` | |
| 4. Server gives/takes it | server/src/world.ts | `addEffect(u` / `removeEffect(u`; GM/self requests: `private requestEffect` |
| 5. Frames for it | scripts/gen-assets.mjs | `// ---------- effects: hats, auras, critters` |

## A creature behavior

| Step | File | Anchor |
| --- | --- | --- |
| 1. Kind / pose types | shared/protocol.ts | `export type CreatureKind`, `export type CreaturePose` |
| 2. Brain (walks, poses, timers) | server/src/creatures.ts | `tick(now: number` and `go(c: Live` |
| 3. World hooks (petting, cups) | server/src/world.ts | `petCreature(u: User` / `putCup(u: User` |
| 4. Frames + tooltip | client/src/creatures.ts | `frameFor(` / `KIND_NAME` |
| 5. Art | scripts/gen-assets.mjs | `// ---------- creatures` |
| 6. Test | server/src/creatures.test.ts | |

## A sprite (object type, decor, frame)

- Draw it in scripts/gen-assets.mjs in **a new `// ---------- <feature>` block at the end**, before `// ---------- pack world atlas`.
- `frames.<type> = t.outline();`. Footprint is `16·w × 16·h` px; floor objects are centred and stand on the footprint's bottom edge (taller art rises above it), wall decor hangs from its top. `<type>_<dir>` variants are picked for objects with a `dir` (chairs).
- **Never call `rnd()` in a new block** (it would reshuffle every frame drawn after it); use fixed pixels or a local hash.
- `npm run gen`, then commit `client/public/assets/*`. Objects are drawn by type name: frame `bell` ↔ `obj('bell', …)`.

## A room

| Step | File | Anchor |
| --- | --- | --- |
| 1. Find space | docs/MAP.md | "Room for a new room" (or grow `W` / `OFFICE_H`) |
| 2. Room entry (rect excludes walls; later rooms win shared tiles) | scripts/gen-map.mjs | `const rooms = [` (append) |
| 3. Walls and doorways | scripts/gen-map.mjs | `// ---- walls ----` (`hDoors`, `sDoors`, vertical dividers; door tiles get `door_floor`) |
| 4. Furniture, standing spots | scripts/gen-map.mjs | append `obj(…)`; `stand('<id>', …)` |
| 5. Reachability checks run on gen | scripts/gen-map.mjs | `layoutProblem(map)` / the `throw new Error` lines at the end |
| 6. Behavior is data: knock, voice, access, homeDesks | `rooms` entry | `rules: {` |
| 7. Floor tile family | scripts/gen-assets.mjs | `floor:` name must have `<name>_0.._2` frames (or `tile_check`) |

A saved admin layout overrides generated furniture: after changing the generator, Reset in edit mode (or drop `layout`
from `data/state.json`). `migrateEastWing` / `withNewFixtures` in world.ts bring new fixtures into old saved layouts.

For `lie` furniture, the only seat is `(o.x + floor((o.w - 1) / 2), o.y)`; the rest blocks walking.
`engine.ts` routes the whole object's click to that seat and rotates the idle sprite along it, head at the seat end;
hammocks also swing. `seatAt` identifies the seat; use the current layout object's `lie` flag for the pose.

## An item (held, hat, drink, throwable)

| Step | File | Anchor |
| --- | --- | --- |
| 1. One `ItemDef`: id, label, emoji `icon`, `kind`, `pocket` (`counts` toward the 6-item limit / `free` for hats / `no`), `actions`, optional `sprite`, `stack`, `daily`, `drink`, `onUse` / `onHit` (data: `{ effect, ms, on }`) | shared/items.ts | `const DEFS: ItemDef[] =` |
| 2. Art beyond the emoji: a frame named like the `sprite` (held layer and floor prop); a hat is `hat_<style>` (add the style to `ALL_HATS` in shared/effects.ts, a height in `HAT_H` in client/src/effects.ts if not 10) | scripts/gen-assets.mjs | a new `// ---------- <feature>` block at the end |
| 3. Where people get it: a `take` object (`items: [{ id, label, icon }]` in gen-map.mjs), a dealer (`use.kind: 'dealer'`), `gm_give`, or a reward | scripts/gen-map.mjs / server/src/world.ts | `const COFFEE =`, `private gmGive(` |
| 4. Moving it: always `World.moveItem(item, from, to, by)` with a `ContainerRef` (`pockets`, `hands`, `desk`, `shelf`, `void`); never edit `u.items` / `holding` directly (limits, duplicates, theft log, worn-hat removal live there) | server/src/world.ts | `moveItem(item: string` |
| 5. Placed in the world (floor, table): a prop, i.e. a `Cup` with `by` and optional `ttl` in `creatures.cups`; saved as `cups` | server/src/creatures.ts | `addCup(` |

The wheel derives from the registry: `heldActions` (your own held item) and `throw` / `give` (on someone else's wheel) in `ActionWheel`.
Pocketable items (`pocket: 'counts'`) stay in the hand until stowed, dropped or thrown; drinks and meals still fade or sip as before.
Desk storage and theft rules: AGENTS.md "Pockets (inventory)".

## Vacation

`shared/beach.ts` owns `terrainAt` and `onMap`: use `onMap` for drawing and tile occupancy, but keep offline
checks for live interactions. `server/src/vacations.ts` reads current calendar absences and `server/src/beach.ts`
walks offline vacationers; `net.ts` stores `vacation` updates. `engine.ts` draws terrain poses, 🌴 plates and return
tooltips; `Vacation.tsx` shares the sorted vacation list and locale-aware return labels between the sign panel and
People group. Calendar-date `back` values format in UTC, timed `until` values in the viewer's zone. The sign opens
through `e.onPick`; the panel's store flag must also suppress instrument keys. Native `busy` includes vacation.

## A panel (React chrome)

| Step | File | Anchor |
| --- | --- | --- |
| 1. Open flag + open/close methods | client/src/net.ts | e.g. `libraryOpen = false;` / `openLibrary(` |
| 2. Render it | client/src/App.tsx | `{store.libraryOpen && <LibraryPanel` |
| 3. Keep instrument keys quiet while it's open | client/src/App.tsx | `dialogOpen={!!(` on `<InstrumentPanel` |
| 4. Bigger panels: their own file | client/src/<Feature>.tsx | like `Library.tsx`, `Presentation.tsx` |
| 5. Styles | client/src/styles.css | phones/short windows: `@media (max-width: 560px), (max-height: 500px)` (the CSS twin of `COMPACT` in `client/src/sidebar/hooks.ts`); type sizes per [UI.md](UI.md) |

## Merge rules for parallel sessions

- Append, don't insert: new rooms at the end of `rooms`, new `obj(…)` at the end of the object list (object ids are positional), new art blocks at the end of gen-assets.mjs.
- Keep additions in their own block: a `// ---------- <feature> ----------` section in world.ts, its own `case` lines in `handle`, its own comment-tagged lines in `ClientMsg`/`ServerMsg`. Don't reformat neighbours.
- Generated files (`shared/tilemap.json`, `client/public/assets/*`, `docs/MAP.md`): on conflict take either side, merge the sources, then `npm run gen` and commit the result.
- Before committing: `npm run gen` (if generators or map changed), `npm run typecheck`, `npm test`.
