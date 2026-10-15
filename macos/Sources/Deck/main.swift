// The Deck for macOS: a menu bar app that hosts the web client in one WKWebView.
// The same web view moves between a popover under the menu bar icon, a normal window and an optional
// borderless window pinned to the desktop, so there's only ever one page / one WebSocket.
import AppKit
import WebKit

let instances: [(name: String, url: String)] = [
  ("prod", "https://voffice.t1a.io"),
  ("andr", "https://voffice-andr.pub.t1a.cloud"),
  ("var", "https://voffice-var.pub.t1a.cloud"),
  ("iva", "https://voffice-iva.pub.t1a.cloud"),
  ("local dev", "http://localhost:5173"),
]

/// Borderless windows can't take keyboard focus unless they say so.
final class DeskWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSPopoverDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
  let defaults = UserDefaults.standard
  var status: NSStatusItem!
  var web: WKWebView!
  var popover: NSPopover!    // under the menu bar icon (left click)
  var slot: NSView!          // where the web view sits inside the popover
  var pinButton: NSButton!
  var window: NSWindow!      // separate window, opened from the popover
  var desk: DeskWindow!      // pinned to the desktop
  var arranging = false
  var state: (connected: Bool, inCall: Bool, knocks: [String]) = (false, false, [])

  var url: String {
    get { defaults.string(forKey: "url") ?? instances[0].url }
    set { defaults.set(newValue, forKey: "url") }
  }
  var pinned: Bool {
    get { defaults.bool(forKey: "pinned") }
    set { defaults.set(newValue, forKey: "pinned") }
  }
  var popOnKnock: Bool {
    get { defaults.object(forKey: "popOnKnock") as? Bool ?? true }
    set { defaults.set(newValue, forKey: "popOnKnock") }
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    NSApp.mainMenu = editMenu()

    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "deck")
    config.mediaTypesRequiringUserActionForPlayback = [] // knock sound without a click first
    config.preferences.inactiveSchedulingPolicy = .none  // keep the WebSocket and voice alive when hidden
    web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = self
    web.navigationDelegate = self
    web.isInspectable = true // Safari ▸ Develop ▸ The Deck

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "The Deck"
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("DeckWindow")

    desk = DeskWindow(contentRect: NSRect(x: 80, y: 80, width: 640, height: 420),
                      styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
    desk.title = "The Deck (desktop)"
    desk.isReleasedWhenClosed = false
    desk.hasShadow = true
    desk.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    desk.setFrameAutosaveName("DeckDesk")
    deskLevel()

    popover = NSPopover()
    popover.behavior = .transient
    popover.animates = false
    popover.delegate = self
    popover.contentViewController = popoverContent()

    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    status.button?.target = self
    status.button?.action = #selector(statusClicked)
    status.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    renderIcon()

    load()
    placeWeb()
  }

  // MARK: hosting the one web view

  func load() { if let u = URL(string: url) { web.load(URLRequest(url: u)) } }

  /// One web view, one place at a time: the separate window if open, else the popover if shown,
  /// else the desktop (if pinned), else nowhere (still loaded and connected, just not on screen).
  func placeWeb() {
    let onDesk = pinned && !window.isVisible && !popover.isShown
    if window.isVisible { if web.superview !== window.contentView { web.removeFromSuperview(); window.contentView = web } }
    else if popover.isShown { if web.superview !== slot { web.removeFromSuperview(); fill(slot, with: web) } }
    else if onDesk { if web.superview !== desk.contentView { web.removeFromSuperview(); desk.contentView = web } }
    else { web.removeFromSuperview() }
    if onDesk { desk.orderFront(nil) } else { desk.orderOut(nil) }
    pinButton?.state = pinned ? .on : .off
  }

  func fill(_ parent: NSView, with child: NSView) {
    child.translatesAutoresizingMaskIntoConstraints = false
    parent.addSubview(child)
    NSLayoutConstraint.activate([child.leadingAnchor.constraint(equalTo: parent.leadingAnchor), child.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
                                 child.topAnchor.constraint(equalTo: parent.topAnchor), child.bottomAnchor.constraint(equalTo: parent.bottomAnchor)])
  }

  /// Popover = a slim header (pin, open in window, menu) over the web view.
  func popoverContent() -> NSViewController {
    func button(_ symbol: String, _ tip: String, _ sel: Selector) -> NSButton {
      let b = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tip)!, target: self, action: sel)
      b.bezelStyle = .accessoryBarAction; b.isBordered = false; b.toolTip = tip; return b
    }
    let title = NSTextField(labelWithString: "The Deck")
    title.font = .boldSystemFont(ofSize: 12)
    pinButton = button("pin", "Pin to desktop", #selector(togglePinned))
    pinButton.setButtonType(.pushOnPushOff)
    let more = button("ellipsis.circle", "More", #selector(moreClicked(_:)))
    let open = button("macwindow.on.rectangle", "Open in a separate window", #selector(openClicked))
    let bar = NSStackView(views: [title, NSView(), pinButton, open, more])
    bar.edgeInsets = NSEdgeInsets(top: 4, left: 10, bottom: 4, right: 8)
    bar.translatesAutoresizingMaskIntoConstraints = false
    slot = NSView()
    slot.translatesAutoresizingMaskIntoConstraints = false
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 860, height: 580))
    root.addSubview(bar); root.addSubview(slot)
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: root.topAnchor), bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: root.trailingAnchor), bar.heightAnchor.constraint(equalToConstant: 30),
      slot.topAnchor.constraint(equalTo: bar.bottomAnchor), slot.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      slot.trailingAnchor.constraint(equalTo: root.trailingAnchor), slot.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
    let vc = NSViewController(); vc.view = root
    return vc
  }

  func showPopover() {
    if window.isVisible { return showWindow() } // it's in the window right now; just bring that forward
    guard let b = status.button else { return }
    popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
    NSApp.activate()
    placeWeb()
  }

  func popoverDidClose(_ note: Notification) { placeWeb() }

  func deskLevel() {
    // Just above the desktop icons, below every normal window.
    desk.level = arranging ? .floating : NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    desk.styleMask = arranging ? [.titled, .resizable] : [.borderless, .resizable]
    desk.title = "Drag and resize, then choose Done arranging"
  }

  func showWindow() {
    if popover.isShown { popover.performClose(nil) }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    placeWeb()
  }

  func windowWillClose(_ note: Notification) {
    guard note.object as? NSWindow === window else { return }
    DispatchQueue.main.async { self.placeWeb() } // isVisible is still true inside willClose
  }

  // MARK: menu bar

  @objc func statusClicked() {
    if NSApp.currentEvent?.type == .rightMouseUp { return showMenu() }
    if popover.isShown { popover.performClose(nil) } else { showPopover() }
  }

  func showMenu() {
    if popover.isShown { popover.performClose(nil) }
    status.menu = buildMenu()
    status.button?.performClick(nil) // pops the menu
    status.menu = nil                // so a left click goes back to the popover
  }

  @objc func moreClicked(_ sender: NSButton) {
    buildMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
  }

  func buildMenu() -> NSMenu {
    let m = NSMenu()
    func item(_ title: String, _ sel: Selector, on: Bool = false, key: String = "") -> NSMenuItem {
      let i = NSMenuItem(title: title, action: sel, keyEquivalent: key); i.target = self; i.state = on ? .on : .off; return i
    }
    m.addItem(withTitle: state.connected ? (state.inCall ? "In a call" : "Connected") : "Not connected", action: nil, keyEquivalent: "")
    for k in state.knocks { m.addItem(withTitle: "🚪 \(k)", action: nil, keyEquivalent: "") }
    m.addItem(.separator())
    m.addItem(item("Open in a separate window", #selector(openClicked)))
    m.addItem(item("Pin to desktop", #selector(togglePinned), on: pinned))
    if pinned { m.addItem(item(arranging ? "Done arranging" : "Arrange desktop window…", #selector(toggleArranging))) }
    m.addItem(item("Pop up on knock", #selector(togglePop), on: popOnKnock))
    m.addItem(.separator())
    let inst = NSMenuItem(title: "Instance", action: nil, keyEquivalent: ""), sub = NSMenu()
    for (n, u) in instances {
      let i = item("\(n)  \(u)", #selector(pickInstance(_:)), on: u == url); i.representedObject = u; sub.addItem(i)
    }
    if !instances.contains(where: { $0.url == url }) { sub.addItem(item(url, #selector(reloadClicked), on: true)) }
    sub.addItem(.separator())
    sub.addItem(item("Custom URL…", #selector(customInstance)))
    inst.submenu = sub
    m.addItem(inst)
    m.addItem(item("Reload", #selector(reloadClicked), key: "r"))
    m.addItem(item("Open in browser", #selector(openInBrowser)))
    m.addItem(.separator())
    m.addItem(item("Quit The Deck", #selector(quit), key: "q"))
    return m
  }

  @objc func openClicked() { showWindow() }
  @objc func togglePinned() { pinned.toggle(); if !pinned { arranging = false; deskLevel() }; placeWeb() }
  @objc func toggleArranging() {
    arranging.toggle(); deskLevel()
    if arranging { if popover.isShown { popover.performClose(nil) }; desk.makeKeyAndOrderFront(nil); NSApp.activate() }
  }
  @objc func togglePop() { popOnKnock.toggle() }
  @objc func pickInstance(_ sender: NSMenuItem) { if let u = sender.representedObject as? String { url = u; load() } }
  @objc func customInstance() {
    let a = NSAlert(); a.messageText = "Deck URL"; a.addButton(withTitle: "Open"); a.addButton(withTitle: "Cancel")
    let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); f.stringValue = url; a.accessoryView = f
    NSApp.activate()
    if a.runModal() == .alertFirstButtonReturn, URL(string: f.stringValue)?.scheme?.hasPrefix("http") == true { url = f.stringValue; load() }
  }
  @objc func reloadClicked() { web.reload() }
  @objc func openInBrowser() { if let u = URL(string: url) { NSWorkspace.shared.open(u) } }
  @objc func quit() { NSApp.terminate(nil) }

  func renderIcon() {
    let name = !state.knocks.isEmpty ? "door.left.hand.open" : state.inCall ? "waveform" : "door.left.hand.closed"
    let img = NSImage(systemSymbolName: name, accessibilityDescription: "The Deck")
    img?.isTemplate = state.knocks.isEmpty
    status.button?.image = state.knocks.isEmpty ? img
      : img?.withSymbolConfiguration(.init(paletteColors: [.systemOrange]))
    status.button?.appearsDisabled = !state.connected
    status.button?.toolTip = state.knocks.first ?? (state.inCall ? "In a call" : "The Deck")
  }

  // MARK: page → app (client/src/native.ts)

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let m = message.body as? [String: Any], m["type"] as? String == "state" else { return }
    let knocks = m["knocks"] as? [String] ?? []
    let newKnock = knocks.count > state.knocks.count
    state = (m["connected"] as? Bool ?? false, m["inCall"] as? Bool ?? false, knocks)
    renderIcon()
    if newKnock && popOnKnock && !popover.isShown && !(window.isVisible && NSApp.isActive) { showPopover() }
  }

  // MARK: web view plumbing

  // Microphone for voice calls: the page asks, macOS shows its own prompt the first time.
  func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
               type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(type == .microphone ? .grant : .deny)
  }

  // target=_blank / window.open (Meet links etc.) go to the default browser.
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = action.request.url { NSWorkspace.shared.open(u) }
    return nil
  }

  // Links to other sites go to the browser; the Deck and its sign-in redirects stay here.
  func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.navigationType == .linkActivated, let u = action.request.url, u.host != URL(string: url)?.host {
      NSWorkspace.shared.open(u); return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = msg; a.runModal(); completionHandler()
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = msg; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  /// Accessory apps have no menu bar of their own, but copy/paste shortcuts still need an Edit menu.
  func editMenu() -> NSMenu {
    let main = NSMenu(), edit = NSMenuItem(), m = NSMenu(title: "Edit")
    m.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    m.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    m.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    m.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    m.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    m.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    m.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    m.addItem(withTitle: "Reload", action: #selector(reloadClicked), keyEquivalent: "r").target = self
    edit.submenu = m; main.addItem(edit)
    return main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
