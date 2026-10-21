// The pinned window: the same borderless window either just above the desktop icons (under everything) or
// floating above every other window. It has no title bar, and the web view takes every mouse event, so a thin
// strip along its top edge is what you grab to move it; the edges resize it as usual.
import AppKit

enum PinMode: String { case off, desktop, top }

final class DragStrip: NSView {
  override var mouseDownCanMoveWindow: Bool { false }
  override func mouseDown(with e: NSEvent) { window?.performDrag(with: e) }
  override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 14) }
  override func draw(_ r: NSRect) {
    NSColor.windowBackgroundColor.setFill(); bounds.fill()
    NSColor.tertiaryLabelColor.setFill()
    NSBezierPath(roundedRect: NSRect(x: bounds.midX - 18, y: bounds.midY - 2, width: 36, height: 4), xRadius: 2, yRadius: 2).fill()
  }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
}

extension AppDelegate {
  /// Where the pinned window sits in the stack, and how it behaves across Spaces and full-screen apps.
  func applyPin() {
    switch pinMode {
    case .top:
      desk.level = .floating
      desk.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    default:
      // Just above the desktop icons, below every normal window.
      desk.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
      desk.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    }
    desk.title = pinMode == .top ? "\(appName) (on top)" : "\(appName) (desktop)"
  }

  func setPin(_ mode: PinMode) {
    pinMode = mode
    applyPin()
    placeWeb()
    settings?.refresh()
  }
}
