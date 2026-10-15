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

  /// color nil = template (follows the menu bar's light/dark). call adds sound waves beside the head.
  static func image(_ art: [String] = standing, color: NSColor? = nil, call: Bool = false, pixel: CGFloat = 1) -> NSImage {
    let cols = art[0].count + (call ? 4 : 0), rows = art.count
    let img = NSImage(size: NSSize(width: CGFloat(cols) * pixel, height: CGFloat(rows) * pixel), flipped: true) { _ in
      (color ?? .black).setFill()
      for (y, line) in art.enumerated() {
        for (x, ch) in line.enumerated() where ch == "#" { NSRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel).fill() }
      }
      if call { // two little arcs: )) to the right of the head
        for (x, y) in [(12, 1), (13, 2), (13, 3), (12, 4), (14, 0), (15, 1), (15, 2), (15, 3), (15, 4), (14, 5)] {
          NSRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel).fill()
        }
      }
      return true
    }
    img.isTemplate = color == nil
    img.accessibilityDescription = "The Deck"
    return img
  }
}
