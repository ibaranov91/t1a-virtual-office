// The menu bar icon: a little 8-bit person, like the sprites on the floor. One shape for every state,
// only the color (and a knock pose) changes, so it's always recognizable.
import AppKit

enum Person {
  static let standing = [
    "....####....",
    "...######...",
    "...######...",
    "....####....",
    "............",
    "..########..",
    ".##########.",
    ".#.######.#.",
    ".#.######.#.",
    ".#.######.#.",
    "...######...",
    "...##..##...",
    "...##..##...",
    "...##..##...",
    "...##..##...",
  ]
  /// Arm raised to knock.
  static let knocking = [
    "....####....",
    "...######.#.",
    "...######.#.",
    "....####..#.",
    "..........#.",
    "..#########.",
    ".##########.",
    ".#.######...",
    ".#.######...",
    ".#.######...",
    "...######...",
    "...##..##...",
    "...##..##...",
    "...##..##...",
    "...##..##...",
  ]

  /// Unread messages: the same blue as the 💬 badges in the web client.
  static let unreadBlue = NSColor(red: 0x6a / 255.0, green: 0x8a / 255.0, blue: 0xd0 / 255.0, alpha: 1)

  /// Mic (5x7) over speaker (7x6) beside the person, mirroring the page's buttons: green = on, red = muted/deafened, dim = not in use.
  static let micArt = [".###.", ".###.", "#.#.#", "#.#.#", ".###.", "..#..", ".###."]
  static let speakerArt = ["...#...", "..##.#.", "####..#", "####..#", "..##.#.", "...#..."]
  enum Glyph { case none, dim, on, off }

  /// color nil = template (follows the menu bar's light/dark). mic and speaker add the glyphs beside the person (any glyph makes it non-template);
  /// dot adds a blue unread dot at the top right (then the image can't be a template, so the person is
  /// drawn in the menu bar's label color).
  /// Pointed at anything but prod (a test instance, the demo, local dev), the person gets a small purple mark
  /// at the bottom right, so it's easy to tell which office the menu bar is showing. Set by AppDelegate.load().
  static var isTestInstance = false

  static func image(_ art: [String] = standing, color: NSColor? = nil, mic: Glyph = .none, speaker: Glyph = .none, dot: Bool = false, pixel: CGFloat = 1) -> NSImage {
    let test = isTestInstance
    let cols = art[0].count + (mic != .none ? 8 : 0) + (dot ? 4 : 0), rows = art.count
    let img = NSImage(size: NSSize(width: CGFloat(cols) * pixel, height: CGFloat(rows) * pixel), flipped: true) { _ in
      (color ?? (dot || test || mic != .none ? .labelColor : .black)).setFill()
      for (y, line) in art.enumerated() {
        for (x, ch) in line.enumerated() where ch == "#" { NSRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel).fill() }
      }
      func glyph(_ art: [String], x0: Int, y0: Int, _ g: Glyph) {
        switch g {
        case .none: return
        case .dim: NSColor.labelColor.withAlphaComponent(0.4).setFill()
        case .on: NSColor.systemGreen.setFill()
        case .off: NSColor.systemRed.setFill()
        }
        for (y, line) in art.enumerated() {
          for (x, ch) in line.enumerated() where ch == "#" { NSRect(x: CGFloat(x0 + x) * pixel, y: CGFloat(y0 + y) * pixel, width: pixel, height: pixel).fill() }
        }
      }
      glyph(micArt, x0: 14, y0: 0, mic)
      glyph(speakerArt, x0: 13, y0: 8, speaker)
      if test {
        NSColor.systemPurple.setFill()
        NSRect(x: 9 * pixel, y: CGFloat(rows - 3) * pixel, width: 3 * pixel, height: 3 * pixel).fill()
      }
      if dot {
        unreadBlue.setFill()
        NSRect(x: CGFloat(cols - 3) * pixel, y: 0, width: 3 * pixel, height: 3 * pixel).fill()
      }
      return true
    }
    img.isTemplate = color == nil && !dot && !test && mic == .none
    img.accessibilityDescription = "The Deck"
    return img
  }
}
