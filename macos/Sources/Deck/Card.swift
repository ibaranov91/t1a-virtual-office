// The small card that hangs from the menu bar icon when someone knocks or a calendar meeting is about to start.
// It only says who or what: Open brings up The Deck (where you accept or Go, so voice starts from a click in the page);
// Later declines the knock or puts the meeting's heads-up away.
import AppKit

struct DeckState {
  var connected = false, inCall = false, busy = false
  var mic = "off", speaker = "off" // as the page's buttons: mic idle|live|muted|err|off, speaker live|deafened|off
  var voiceMenu = false, micOff = true, micErr = false, soundOff = false // the menu's mic and sound items, as the page's buttons
  var knocks: [(id: String, text: String)] = []
  var meetings: [(id: String, text: String)] = [] // heads-ups a minute before a meeting; id = the meeting's key
  var unread: [(id: String, name: String, count: Int)] = [] // oldest first
}

/// The card isn't key when it appears (we don't steal focus), so its buttons must take the first click.
final class FirstMouseButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class KnockCard: NSObject {
  let popover = NSPopover()
  private(set) var knockId: String?, meetingKey: String?
  var onLater: (String) -> Void = { _ in }
  var onMeetingLater: (String) -> Void = { _ in }
  var onOpen: () -> Void = {}

  override init() {
    super.init()
    popover.behavior = .applicationDefined // stays until answered or expired; no focus needed
  }

  func show(id: String, text: String, from anchor: NSView) {
    knockId = id; meetingKey = nil
    present(build(text, detail: "Open The Deck to answer", symbol: "door.left.hand.open", color: .systemOrange), from: anchor)
  }
  func showMeeting(key: String, text: String, from anchor: NSView) {
    meetingKey = key; knockId = nil
    present(build(text, detail: "Open The Deck to step into its room", symbol: "calendar", color: .systemBlue), from: anchor)
  }
  private func present(_ view: NSView, from anchor: NSView) {
    let vc = NSViewController(); vc.view = view
    vc.preferredContentSize = vc.view.fittingSize
    popover.contentViewController = vc
    if !popover.isShown { popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY) }
  }

  func close() { knockId = nil; meetingKey = nil; if popover.isShown { popover.performClose(nil) } }

  private func build(_ text: String, detail: String, symbol: String, color: NSColor) -> NSView {
    let later = FirstMouseButton(title: "Later", target: self, action: #selector(laterClicked))
    let open = FirstMouseButton(title: "Open", target: self, action: #selector(openClicked))
    open.keyEquivalent = "\r"; open.bezelColor = color
    let image = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil)!
      .withSymbolConfiguration(.init(pointSize: 22, weight: .medium).applying(.init(paletteColors: [color])))!)
    let t = NSTextField(wrappingLabelWithString: text); t.font = .boldSystemFont(ofSize: 13)
    t.preferredMaxLayoutWidth = 240
    let d = NSTextField(labelWithString: detail); d.font = .systemFont(ofSize: 11); d.textColor = .secondaryLabelColor
    let words = NSStackView(views: [t, d]); words.orientation = .vertical; words.alignment = .leading; words.spacing = 2
    let head = NSStackView(views: [image, words]); head.spacing = 10; head.alignment = .centerY
    let row = NSStackView(views: [NSView(), later, open]); row.spacing = 6
    let root = NSStackView(views: [head, row]); root.orientation = .vertical; root.alignment = .leading; root.spacing = 10
    root.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
    root.widthAnchor.constraint(equalToConstant: 300).isActive = true
    row.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -28).isActive = true
    return root
  }

  @objc private func laterClicked() { if let id = knockId { onLater(id) }; if let key = meetingKey { onMeetingLater(key) }; close() }
  @objc private func openClicked() { close(); onOpen() }
}
