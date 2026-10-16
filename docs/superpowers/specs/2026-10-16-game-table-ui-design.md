# Game table UI redesign

Andrii's feedback on the first game table: the games work, but the screen reads as slop. The board is a small
pixel canvas that ignores the window, black players see the board from white's side, the host picks a game from an
unstyled native select, and most of the screen is empty. The table should feel like chess.com and look like the
Discord-style sidebar: plain, technical, obvious.

Rules, protocol and server flow stay as they are. Only the overlay is replaced, plus a move history for draughts.

## Layout

A full-screen activity, like the arcade, built from the sidebar's vocabulary (`--panel` surfaces, 1px `--line`
borders, 6–8px radii, uppercase group heads, the sidebar `Avatar`).

- **Header**: "Game table", the current game and host underneath, and Leave table on the right.
- **Stage** (left, fills the window): the board or the card table.
- **Side panel** (right, 340px, sidebar surface): status, move list, game actions, who sits and who watches. Under
  900px it drops below the stage.

## Chess and checkers (chess.com pattern)

- The board is DOM, sized by a ResizeObserver to the largest square that fits between the two player bars, snapped
  to a multiple of 8px so squares stay crisp.
- The board turns toward you: black plays from the bottom. Watchers see white at the bottom.
- Player bars sit above and below the board: avatar, name, colour, captured pieces with the material lead, and a
  clock pill that counts down the 2-minute turn on the side to move. It turns red under 20 seconds.
- Pieces are vector: the cburnett chess set (Colin M.L. Burnett, BSD licence via Wikimedia Commons). Checkers are
  drawn discs, and the king carries a crown.
- Interaction is click-click or drag-and-drop. A dot marks a quiet move and a ring marks a capture. The last move is
  tinted, the selected square is tinted, and a king in check glows red. Coordinates sit inside the edge squares.
- Promotion opens a four-piece picker over the promotion square.
- In checkers you can click the final landing square of a multi-capture directly. The board falls back to
  hop-by-hop only when two routes end on the same square.
- The keyboard moves with the arrow keys over the squares (roving tabindex), and Enter or Space picks the square.
- The side panel shows the move list: SAN for chess (replayed with chess.js) and `c3-d4` / `c3:e5:g3` notation for
  draughts. Offer or accept a draw, and Resign.

## Dominoes and Last Card

- Opponents show along the top as seat chips: avatar, name, a count of face-down tiles or cards, and a turn ring
  with the clock.
- In the middle is the felt: the domino chain (doubles stand upright), or the discard and the draw pile with the
  current colour and direction.
- Your hand sits at the bottom in large vector tiles and cards. Tiles or cards you can play are lifted, and the rest
  are dimmed.
- In dominoes, clicking a tile plays it when it fits only one end. When it fits both ends, both ends light up as
  drop slots. Draw from the boneyard or Pass appear only when nothing fits.
- In Last Card, clicking a playable card plays it. A wild opens a four-colour picker. "Last card!" is a toggle
  that shows while you hold two cards on your turn. After you draw a playable card, it is the only lit card, and
  you can play it or click "Keep". When someone forgets to call, Catch appears prominently.

## Lobby

- The host picks a game from four illustrated tiles: name, player count and a mini illustration. This replaces the
  native select. They then pick players from a row list of seated people with avatars (one for chess and
  checkers, up to three for the others), and press "Invite to Chess".
- An invitation panel shows each invited player as ready or waiting, and a 30-second bar that empties. The host
  sees Start, invitees see Join, and others see who's coming.
- When a game finishes, the final position stays on screen. The result card shows the winner and the reason, with
  Rematch and New game for the host.
- With nobody else seated, the screen says how to fill the table (four seats, the rest watch) instead of showing an
  empty list.
