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

  /// color nil = template (follows the menu bar's light/dark). call adds sound waves beside the head;
  /// dot adds a blue unread dot at the top right (then the image can't be a template, so the person is
  /// drawn in the menu bar's label color).
  /// Test instances' apps ("The Deck (iva)") get a small purple mark at the bottom right, so they're easy to
  /// tell apart from prod's app in the menu bar.
  static let isTestInstance = (Bundle.main.object(forInfoDictionaryKey: "DeckInstance") as? String).map { $0 != "prod" } ?? false

  static func image(_ art: [String] = standing, color: NSColor? = nil, call: Bool = false, dot: Bool = false, pixel: CGFloat = 1) -> NSImage {
    let test = isTestInstance
    let cols = art[0].count + (call ? 4 : 0) + (dot ? 4 : 0), rows = art.count
    let img = NSImage(size: NSSize(width: CGFloat(cols) * pixel, height: CGFloat(rows) * pixel), flipped: true) { _ in
      (color ?? (dot || test ? .labelColor : .black)).setFill()
      for (y, line) in art.enumerated() {
        for (x, ch) in line.enumerated() where ch == "#" { NSRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel).fill() }
      }
      if call { // two little arcs: )) to the right of the head
        for (x, y) in [(12, 1), (13, 2), (13, 3), (12, 4), (14, 0), (15, 1), (15, 2), (15, 3), (15, 4), (14, 5)] {
          NSRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel).fill()
        }
      }
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
    img.isTemplate = color == nil && !dot && !test
    img.accessibilityDescription = "The Deck"
    return img
  }
}
