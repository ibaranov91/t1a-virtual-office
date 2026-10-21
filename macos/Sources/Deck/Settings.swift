// Settings (⌘,): the OS-level things that belong to the app rather than the page: launch at login, which
// instance, the pinned window, the cards under the icon. Game and audio settings stay in the web page, so they
// work in browsers too.
import AppKit
import ServiceManagement

final class SettingsWindow: NSWindowController {
  unowned let app: AppDelegate
  let login = NSButton(checkboxWithTitle: "Open at login", target: nil, action: nil)
  let loginNote = NSTextField(wrappingLabelWithString: "")
  let instance = NSPopUpButton(frame: .zero, pullsDown: false)
  let pin = NSPopUpButton(frame: .zero, pullsDown: false)
  let cards = NSButton(checkboxWithTitle: "Knock and meeting cards under the menu bar icon", target: nil, action: nil)

  init(app: AppDelegate) {
    self.app = app
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 260), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    w.title = "\(appName) Settings"
    w.isReleasedWhenClosed = false
    w.center()
    super.init(window: w)
    login.target = self; login.action = #selector(loginChanged)
    cards.target = self; cards.action = #selector(cardsChanged)
    instance.target = self; instance.action = #selector(instanceChanged)
    pin.target = self; pin.action = #selector(pinChanged)
    for (name, _) in instances { instance.addItem(withTitle: name) }
    instance.addItem(withTitle: "Custom URL…")
    pin.addItems(withTitles: ["Not pinned", "On the desktop, under other windows", "On top of other windows"])
    loginNote.font = .systemFont(ofSize: 11); loginNote.textColor = .secondaryLabelColor; loginNote.preferredMaxLayoutWidth = 300

    let grid = NSGridView(views: [
      [label("Login:"), login], [NSView(), loginNote],
      [label("Instance:"), instance],
      [label("Pinned window:"), pin],
      [label("Cards:"), cards],
      [NSView(), version()],
    ])
    grid.rowSpacing = 10; grid.columnSpacing = 12
    grid.column(at: 0).xPlacement = .trailing
    grid.translatesAutoresizingMaskIntoConstraints = false
    let root = NSView(); root.addSubview(grid)
    NSLayoutConstraint.activate([
      grid.topAnchor.constraint(equalTo: root.topAnchor, constant: 20), grid.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
      grid.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20), grid.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
    ])
    w.contentView = root
  }
  required init?(coder: NSCoder) { fatalError() }

  func label(_ s: String) -> NSTextField { let l = NSTextField(labelWithString: s); l.alignment = .right; return l }
  func version() -> NSTextField {
    let l = NSTextField(labelWithString: appVersion); l.font = .systemFont(ofSize: 11); l.textColor = .tertiaryLabelColor
    l.isSelectable = true; return l
  }

  func show() {
    refresh()
    NSApp.setActivationPolicy(.regular)
    window?.makeKeyAndOrderFront(nil)
    app.activate()
  }

  func refresh() {
    let s = SMAppService.mainApp.status
    login.state = s == .enabled ? .on : .off
    loginNote.stringValue = s == .requiresApproval ? "Allow it under System Settings ▸ General ▸ Login Items." : ""
    if let i = instances.firstIndex(where: { $0.url == app.url }) { instance.selectItem(at: i) }
    else { instance.lastItem?.title = "Custom: \(app.url)"; instance.select(instance.lastItem) }
    pin.selectItem(at: [.off, .desktop, .top].firstIndex(of: app.pinMode) ?? 0)
    cards.state = app.popOnKnock ? .on : .off
  }

  @objc func loginChanged() {
    do {
      if login.state == .on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      let a = NSAlert(); a.messageText = "Couldn't change the login item"; a.informativeText = error.localizedDescription; a.runModal()
    }
    refresh()
  }
  @objc func cardsChanged() { app.popOnKnock = cards.state == .on }
  @objc func pinChanged() { app.setPin([.off, .desktop, .top][max(0, pin.indexOfSelectedItem)]) }
  @objc func instanceChanged() {
    let i = instance.indexOfSelectedItem
    if i >= 0, i < instances.count { app.switchInstance(instances[i].url) } else { app.customInstance(); refresh() }
  }
}

/// "0.1 (123) · build abcdef012345", plus "dev" for a local build (macos/build.sh without --dist).
var appVersion: String {
  let info = Bundle.main.infoDictionary ?? [:]
  let short = info["CFBundleShortVersionString"] as? String ?? "?", n = info["CFBundleVersion"] as? String ?? "?"
  let build = info["DeckBuild"] as? String ?? "?"
  let dev = info["DeckDev"] as? Bool == true ? " · dev build (never self-updates)" : ""
  return "\(appName) \(short) (\(n)) · build \(build)\(dev)"
}
