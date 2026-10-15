// Draws the app icon (a pixel-art door in the office palette) and writes macos/AppIcon.icns.
// Run after changing it:  swift macos/make-icon.swift   (commit the .icns, like the other generated art)
import AppKit

let art = [
  "........................",
  "........................",
  "......OOOOOOOOOOOO......",
  "......OFFFFFFFFFFO......",
  "......OFLLLLLLLLFO......",
  "......OFDDDDDDDDFO......",
  "......OFDddDDddDFO......",
  "......OFDdLDDdLDFO......",
  "......OFDdLDDdLDFO......",
  "......OFDdLDDdLDFO......",
  "......OFDddDDddDFO......",
  "......OFDDDDDDDDFO......",
  "......OFDDDDDDKDFO......",
  "......OFDDDDDDkDFO......",
  "......OFDddDDddDFO......",
  "......OFDdLDDdLDFO......",
  "......OFDdLDDdLDFO......",
  "......OFDdLDDdLDFO......",
  "......OFDddDDddDFO......",
  "......OFDDDDDDDDFO......",
  "......OFDDDDDDDDFO......",
  "gggggggggggggggggggggggg",
  "ffffffffffffffffffffffff",
  "ffffhffffffffffhffffffff",
]
let palette: [Character: String] = [
  ".": "34262c", "O": "3a2329", "F": "7d4a26", "L": "dba066", "D": "c8874a", "d": "9c5f30",
  "K": "f2b45a", "k": "a4622e", "g": "6e4228", "f": "9a6440", "h": "b5763e",
]
func color(_ hex: String) -> CGColor {
  let v = UInt32(hex, radix: 16)!
  return CGColor(red: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}

/// macOS icon grid: an 824/1024 rounded square, centered; the art fills it in whole pixels.
func png(_ size: Int) -> Data {
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let s = CGFloat(size) / 1024, cell = 34 * s, origin = (1024 - 34 * 24) / 2 * s
  let square = CGRect(x: origin, y: origin, width: cell * 24, height: cell * 24)
  ctx.addPath(CGPath(roundedRect: square, cornerWidth: 180 * s, cornerHeight: 180 * s, transform: nil))
  ctx.clip()
  for (row, line) in art.enumerated() {
    for (col, ch) in line.enumerated() {
      ctx.setFillColor(color(palette[ch]!))
      // CG's origin is bottom-left; rows go top-down. Overlap by a hair so small sizes don't show seams.
      ctx.fill(CGRect(x: origin + CGFloat(col) * cell, y: origin + CGFloat(23 - row) * cell, width: cell + 0.5, height: cell + 0.5))
    }
  }
  return NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
}

let dir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let set = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: set)
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  try png(base).write(to: set.appendingPathComponent("icon_\(base)x\(base).png"))
  try png(base * 2).write(to: set.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", set.path, "-o", dir.appendingPathComponent("AppIcon.icns").path]
try p.run(); p.waitUntilExit()
print(p.terminationStatus == 0 ? "Wrote \(dir.path)/AppIcon.icns" : "iconutil failed")
