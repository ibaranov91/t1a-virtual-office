// The small card that hangs from the menu bar icon when someone knocks. It only tells you who it is:
// Open brings up The Deck (where you accept, so voice starts from a click in the page); Later declines.
import AppKit

struct DeckState {
  var connected = false, inCall = false, busy = false
  var mic = "off", speaker = "off" // as the page's buttons: mic idle|live|muted|err|off, speaker live|deafened|off
  var knocks: [(id: String, text: String)] = []
  var unread: [(id: String, name: String, count: Int)] = [] // oldest first
}

/// The card isn't key when it appears (we don't steal focus), so its buttons must take the first click.
final class FirstMouseButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class KnockCard: NSObject {
  let popover = NSPopover()
  private(set) var knockId: String?
  var onLater: (String) -> Void = { _ in }
  var onOpen: () -> Void = {}

  override init() {
    super.init()
    popover.behavior = .applicationDefined // stays until answered or expired; no focus needed
  }

  func show(id: String, text: String, from anchor: NSView) {
    knockId = id
    let vc = NSViewController(); vc.view = build(id, text)
    vc.preferredContentSize = vc.view.fittingSize
    popover.contentViewController = vc
    if !popover.isShown { popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY) }
  }

  func close() { knockId = nil; if popover.isShown { popover.performClose(nil) } }

  private func build(_ id: String, _ text: String) -> NSView {
    let later = FirstMouseButton(title: "Later", target: self, action: #selector(laterClicked))
    let open = FirstMouseButton(title: "Open", target: self, action: #selector(openClicked))
    open.keyEquivalent = "\r"; open.bezelColor = .systemOrange
    let image = NSImageView(image: NSImage(systemSymbolName: "door.left.hand.open", accessibilityDescription: nil)!
      .withSymbolConfiguration(.init(pointSize: 22, weight: .medium).applying(.init(paletteColors: [.systemOrange])))!)
    let t = NSTextField(wrappingLabelWithString: text); t.font = .boldSystemFont(ofSize: 13)
    t.preferredMaxLayoutWidth = 240
    let d = NSTextField(labelWithString: "Open The Deck to answer"); d.font = .systemFont(ofSize: 11); d.textColor = .secondaryLabelColor
    let words = NSStackView(views: [t, d]); words.orientation = .vertical; words.alignment = .leading; words.spacing = 2
    let head = NSStackView(views: [image, words]); head.spacing = 10; head.alignment = .centerY
    let row = NSStackView(views: [NSView(), later, open]); row.spacing = 6
    let root = NSStackView(views: [head, row]); root.orientation = .vertical; root.alignment = .leading; root.spacing = 10
    root.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
    root.widthAnchor.constraint(equalToConstant: 300).isActive = true
    row.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -28).isActive = true
    return root
  }

  @objc private func laterClicked() { if let id = knockId { onLater(id) }; close() }
  @objc private func openClicked() { close(); onOpen() }
}
