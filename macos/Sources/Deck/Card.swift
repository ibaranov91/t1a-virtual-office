// The small card that hangs from the menu bar icon: answer a knock without opening the floor,
// then (after Accept) a mini call bar. Native AppKit; actions go to the page via window.__deckNative.
import AppKit

struct DeckState {
  var connected = false, inCall = false, muted = false, busy = false
  var callWith = ""
  var knocks: [(id: String, text: String)] = []
}

enum CardMode: Equatable { case knock(id: String, text: String), call }

/// The card isn't key when it appears (we don't steal focus), so its buttons must take the first click.
final class FirstMouseButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class KnockCard: NSObject {
  let popover = NSPopover()
  private(set) var mode: CardMode?
  var onReply: (String, String) -> Void = { _, _ in }
  var onMute: () -> Void = {}
  var onLeave: () -> Void = {}
  var onOpen: () -> Void = {}

  override init() {
    super.init()
    popover.behavior = .applicationDefined // stays until answered, expired or hidden; no focus needed
  }

  var isShown: Bool { popover.isShown }

  func show(_ mode: CardMode, _ s: DeckState, from anchor: NSView) {
    self.mode = mode
    actions = [:]
    let vc = NSViewController(); vc.view = build(mode, s)
    vc.preferredContentSize = vc.view.fittingSize
    popover.contentViewController = vc
    if !popover.isShown { popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY) }
  }

  func close() { mode = nil; if popover.isShown { popover.performClose(nil) } }

  private func build(_ mode: CardMode, _ s: DeckState) -> NSView {
    let icon: String, title: String, sub: String, buttons: [NSButton]
    switch mode {
    case .knock(let id, let text):
      icon = "door.left.hand.open"; title = text; sub = "Accept to start a voice call"
      let later = button("Later") { [weak self] in self?.onReply(id, "later") }
      let accept = button("Accept") { [weak self] in self?.onReply(id, "accept") }
      accept.keyEquivalent = "\r"; accept.bezelColor = .systemOrange
      buttons = [later, accept]
    case .call:
      icon = "waveform"; title = s.inCall ? (s.callWith.isEmpty ? "In a call" : "Talking with \(s.callWith)") : "Joining the call…"; sub = !s.inCall ? "Connecting" : s.muted ? "Muted" : "Live"
      buttons = [button(s.muted ? "Unmute" : "Mute") { [weak self] in self?.onMute() },
                 button("Leave") { [weak self] in self?.onLeave() },
                 button("Open") { [weak self] in self?.onOpen() },
                 button("Hide") { [weak self] in self?.close() }]
    }
    let image = NSImageView(image: NSImage(systemSymbolName: icon, accessibilityDescription: nil)!
      .withSymbolConfiguration(.init(pointSize: 22, weight: .medium).applying(.init(paletteColors: [.systemOrange])))!)
    let t = NSTextField(wrappingLabelWithString: title); t.font = .boldSystemFont(ofSize: 13)
    let d = NSTextField(labelWithString: sub); d.font = .systemFont(ofSize: 11); d.textColor = .secondaryLabelColor
    let text = NSStackView(views: [t, d]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 2
    let head = NSStackView(views: [image, text]); head.spacing = 10; head.alignment = .centerY
    let row = NSStackView(views: [NSView()] + buttons); row.spacing = 6
    let root = NSStackView(views: [head, row]); root.orientation = .vertical; root.alignment = .leading; root.spacing = 10
    root.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
    root.widthAnchor.constraint(equalToConstant: 300).isActive = true
    row.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -28).isActive = true
    t.preferredMaxLayoutWidth = 240
    return root
  }

  private var actions: [ObjectIdentifier: () -> Void] = [:]
  private func button(_ title: String, _ action: @escaping () -> Void) -> NSButton {
    let b = FirstMouseButton(title: title, target: self, action: #selector(clicked(_:)))
    b.bezelStyle = .push; b.controlSize = .regular
    actions[ObjectIdentifier(b)] = action
    return b
  }
  @objc private func clicked(_ b: NSButton) { actions[ObjectIdentifier(b)]?() }
}
