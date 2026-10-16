// The Deck for macOS: a menu bar app that hosts the web client in one WKWebView.
// The same web view moves between a popover under the menu bar icon, a normal window and an optional
// borderless window pinned to the desktop, so there's only ever one page / one WebSocket.
import AppKit
import Network
import WebKit

/// "The Deck": one app for every instance; the install command points it at the instance it came from.
let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "The Deck"

let instances: [(name: String, url: String)] = [
  ("prod", "https://voffice.t1a.io"),
  ("andr", "https://voffice-andr.pub.t1a.cloud"),
  ("var", "https://voffice-var.pub.t1a.cloud"),
  ("iva", "https://voffice-iva.pub.t1a.cloud"),
  ("demo", "https://voffice-demo.pub.t1a.cloud"),
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
  var state = DeckState() { didSet { holdForCall(state.connected && state.inCall) } }
  var callActivity: NSObjectProtocol? // held during a call so App Nap doesn't throttle a hidden web view's voice
  let card = KnockCard()
  let updater = Updater()
  let wellness = WellnessNotifications()
  var updateButton: NSButton!
  var windowRoot = NSView() // the window's content: the web view, with the menu bar note on top
  var note: NSView?
  var ringing: Timer?
  // Offline.swift: page load state, retries, network watch
  var pageOK = false                // the main page finished loading
  var loadError: String?            // why the last load failed; the offline card is up while set
  var attempt = 0                   // failed loads in a row, for the backoff
  var retryAt: Date?
  var retryTimer, loadTimeout, networkDebounce, socketTimer: Timer?
  var socketDownSince: Date?
  var lastCrash: Date?
  var offlineView: OfflineView?
  var pathMonitor: NWPathMonitor?

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
    wellness.onPermission = { [weak self] status in self?.js("window.__deckNative?.wellnessPermission(\(json(status)))") }
    wellness.isInFront = { [weak self] in
      guard let self, self.pageOK else { return false }
      return self.popover?.isShown == true || (NSApp.isActive && (self.window?.isVisible == true || self.desk?.isVisible == true))
    }
    wellness.onOpen = { [weak self] kind in
      guard let self else { return }
      self.showWindow()
      if !kind.isEmpty { self.js("window.__deckNative?.openWellness(\(json(kind)))") }
    }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.wellness.refreshPermission()
    }
    NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main) { [weak self] n in
      if (n.object as? NSWindow) === self?.web.window { self?.updateCovered() }
    }
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
    window.title = appName
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("DeckWindow")
    window.contentView = windowRoot

    desk = DeskWindow(contentRect: NSRect(x: 80, y: 80, width: 640, height: 420),
                      styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
    desk.title = "\(appName) (desktop)"
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

    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength) // the in-call icon is wider
    status.button?.target = self
    status.button?.action = #selector(statusClicked)
    status.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    renderIcon()

    card.onLater = { [weak self] id in self?.js("__deckNative.reply(\(json(id)), 'later')") }
    card.onMeetingLater = { [weak self] key in self?.js("__deckNative.dismissMeeting?.(\(json(key)))") }
    updater.onChange = { [weak self] in self?.renderUpdate() }
    card.onOpen = { [weak self] in self?.showPopover() }

    load()
    placeWeb()
    startWatchingNetwork()
    // A menu bar app has no Dock icon, so opening it from Applications looked like nothing happened.
    // Opening it (not a relaunch after a self-update) shows the window plus a note on where it lives.
    if !CommandLine.arguments.contains("--updated") { openedByUser() }
  }

  /// Opened again from Applications / Spotlight while already running.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if window.isVisible { showWindow() } else { openedByUser() } // Dock click on an open window: just focus it
    return false
  }

  func openedByUser() {
    showWindow()
    window.orderFrontRegardless() // macOS may not let a just-launched menu bar app take focus
    showMenuBarNote()
  }

  /// A small card in the middle of the window: closing it is fine, the menu bar icon brings it back.
  func showMenuBarNote() {
    note?.removeFromSuperview()
    let box = NSVisualEffectView()
    box.material = .hudWindow; box.blendingMode = .withinWindow; box.state = .active
    box.wantsLayer = true; box.layer?.cornerRadius = 12
    let icon = NSImageView(image: Person.image(color: .systemOrange, pixel: 3))
    let title = NSTextField(labelWithString: "\(appName) lives in your menu bar")
    title.font = .boldSystemFont(ofSize: 15)
    let text = NSTextField(wrappingLabelWithString: "Close this window anytime and stay in the office. Click the little person at the top of your screen to open it again, right-click it for options.")
    text.font = .systemFont(ofSize: 12); text.textColor = .secondaryLabelColor; text.alignment = .center
    text.preferredMaxLayoutWidth = 300
    let ok = NSButton(title: "Got it", target: self, action: #selector(hideMenuBarNote))
    ok.keyEquivalent = "\r"; ok.bezelColor = .systemOrange
    let stack = NSStackView(views: [icon, title, text, ok])
    stack.orientation = .vertical; stack.spacing = 8; stack.alignment = .centerX
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    stack.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(stack)
    box.translatesAutoresizingMaskIntoConstraints = false
    windowRoot.addSubview(box) // above the web view
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: box.leadingAnchor), stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
      stack.topAnchor.constraint(equalTo: box.topAnchor), stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
      box.widthAnchor.constraint(equalToConstant: 340),
      box.centerXAnchor.constraint(equalTo: windowRoot.centerXAnchor), box.centerYAnchor.constraint(equalTo: windowRoot.centerYAnchor),
    ])
    note = box
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak box] in if let box, box === self.note { self.hideMenuBarNote() } }
  }

  @objc func hideMenuBarNote() {
    guard let box = note else { return }
    note = nil
    NSAnimationContext.runAnimationGroup({ $0.duration = 0.3; box.animator().alphaValue = 0 }, completionHandler: { box.removeFromSuperview() })
  }

  // MARK: hosting the one web view

  func load() {
    Person.isTestInstance = URL(string: url)?.host != URL(string: instances[0].url)?.host
    renderIcon()
    if let u = URL(string: url) { web.load(URLRequest(url: u)) }
  }

  /// One web view, one place at a time: the separate window if open, else the popover if shown,
  /// else the desktop (if pinned), else nowhere (still loaded and connected, just not on screen).
  func placeWeb() {
    let onDesk = pinned && !window.isVisible && !popover.isShown
    if window.isVisible { if web.superview !== windowRoot { web.removeFromSuperview(); fill(windowRoot, with: web) } }
    else if popover.isShown { if web.superview !== slot { web.removeFromSuperview(); fill(slot, with: web) } }
    else if onDesk { if web.superview !== desk.contentView { web.removeFromSuperview(); desk.contentView = web } }
    else { web.removeFromSuperview() }
    if onDesk { desk.orderFront(nil) } else { desk.orderOut(nil) }
    pinButton?.state = pinned ? .on : .off
    DispatchQueue.main.async { self.updateCovered() } // the web view's window may have just changed
  }

  /// Tell the page when whatever hosts the web view is fully hidden behind other windows, so it stops drawing
  /// (a pinned desktop window is "visible" to WebKit all day). No window at all counts as covered too.
  var covered = false
  func updateCovered() {
    let now = web.window.map { !$0.occlusionState.contains(.visible) } ?? true
    guard now != covered else { return }
    covered = now
    js("window.__deckNative?.setCovered(\(now))")
  }

  func fill(_ parent: NSView, with child: NSView) {
    child.translatesAutoresizingMaskIntoConstraints = false
    parent.addSubview(child, positioned: .below, relativeTo: nil)
    NSLayoutConstraint.activate([child.leadingAnchor.constraint(equalTo: parent.leadingAnchor), child.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
                                 child.topAnchor.constraint(equalTo: parent.topAnchor), child.bottomAnchor.constraint(equalTo: parent.bottomAnchor)])
  }

  /// Popover = a slim header (pin, open in window, menu) over the web view.
  func popoverContent() -> NSViewController {
    func button(_ symbol: String, _ tip: String, _ sel: Selector) -> NSButton {
      let b = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tip)!, target: self, action: sel)
      b.bezelStyle = .accessoryBarAction; b.isBordered = false; b.toolTip = tip; return b
    }
    let title = NSTextField(labelWithString: appName)
    title.font = .boldSystemFont(ofSize: 12)
    pinButton = button("pin", "Pin to desktop", #selector(togglePinned))
    updateButton = NSButton(title: "Update", target: self, action: #selector(updateClicked))
    updateButton.bezelStyle = .accessoryBarAction; updateButton.contentTintColor = .systemOrange; updateButton.isHidden = true
    pinButton.setButtonType(.pushOnPushOff)
    let more = button("ellipsis.circle", "More", #selector(moreClicked(_:)))
    let open = button("macwindow.on.rectangle", "Open in a separate window", #selector(openClicked))
    let bar = NSStackView(views: [title, NSView(), updateButton, pinButton, open, more])
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
    card.close()
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
    NSApp.setActivationPolicy(.regular) // in the Dock (and ⌘-Tab) while the window is open
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    placeWeb()
  }

  func windowWillClose(_ n: Notification) {
    guard n.object as? NSWindow === window else { return }
    note?.removeFromSuperview(); note = nil
    DispatchQueue.main.async { // isVisible is still true inside willClose
      self.placeWeb()
      NSApp.setActivationPolicy(.accessory) // back to just the menu bar
    }
  }

  // MARK: menu bar

  @objc func statusClicked() {
    card.close()
    if NSApp.currentEvent?.type == .rightMouseUp { return showMenu() }
    if let first = state.unread.first, !popover.isShown { return openChat(first.id) } // straight to the oldest unread chat
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
    if offline {
      m.addItem(withTitle: "Can't reach \(host)", action: nil, keyEquivalent: "")
      m.addItem(item("Retry now", #selector(retryLoad)))
    } else {
      m.addItem(withTitle: state.connected ? (state.inCall ? "In a call" + voiceNote : "Connected") : "Reconnecting…", action: nil, keyEquivalent: "")
    }
    if let u = updater.available {
      m.addItem(updater.busy ? NSMenuItem(title: "Updating…", action: nil, keyEquivalent: "") : item("Update to \(u.version) (restarts the app)", #selector(updateClicked)))
    }
    for k in state.knocks { m.addItem(withTitle: "🚪 \(k.text)", action: nil, keyEquivalent: "") }
    for e in state.meetings { m.addItem(withTitle: e.text, action: nil, keyEquivalent: "") }
    for u in state.unread {
      let i = item("💬 \(u.name) (\(u.count))", #selector(openChatClicked(_:))); i.representedObject = u.id; m.addItem(i)
    }
    if state.busy { m.addItem(withTitle: "Quiet: away or in a call, knocks only light the icon", action: nil, keyEquivalent: "") }
    m.addItem(.separator())
    m.addItem(item("Open in a separate window", #selector(openClicked)))
    m.addItem(item("Pin to desktop", #selector(togglePinned), on: pinned))
    if pinned { m.addItem(item(arranging ? "Done arranging" : "Arrange desktop window…", #selector(toggleArranging))) }
    m.addItem(item("Knock and meeting card under the icon", #selector(togglePop), on: popOnKnock))
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
    m.addItem(item("Quit \(appName)", #selector(quit), key: "q"))
    return m
  }

  @objc func openClicked() { showWindow() }
  @objc func togglePinned() { pinned.toggle(); if !pinned { arranging = false; deskLevel() }; placeWeb() }
  @objc func toggleArranging() {
    arranging.toggle(); deskLevel()
    if arranging { if popover.isShown { popover.performClose(nil) }; desk.makeKeyAndOrderFront(nil); NSApp.activate() }
  }
  @objc func togglePop() { popOnKnock.toggle() }
  @objc func pickInstance(_ sender: NSMenuItem) { if let u = sender.representedObject as? String { wellness.clear(); url = u; load() } }
  @objc func customInstance() {
    let a = NSAlert(); a.messageText = "Deck URL"; a.addButton(withTitle: "Open"); a.addButton(withTitle: "Cancel")
    let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); f.stringValue = url; a.accessoryView = f
    NSApp.activate()
    if a.runModal() == .alertFirstButtonReturn, URL(string: f.stringValue)?.scheme?.hasPrefix("http") == true { wellness.clear(); url = f.stringValue; load() }
  }
  @objc func reloadClicked() { if pageOK { web.reload() } else { retryLoad() } } // nothing to reload after a failed first load
  @objc func openInBrowser() { if let u = URL(string: url) { NSWorkspace.shared.open(u) } }
  @objc func quit() { NSApp.terminate(nil) }

  var micGlyph: Person.Glyph { switch state.mic { case "live": return .on; case "muted", "err": return .off; default: return .dim } }
  var speakerGlyph: Person.Glyph { switch state.speaker { case "live": return .on; case "deafened": return .off; default: return .dim } }
  var voiceNote: String { state.speaker == "deafened" ? " · deafened" : state.mic == "muted" ? " · muted" : "" }

  func renderIcon() {
    // same little person always: orange = someone's knocking, green + mic and speaker = you're in a call
    // blue dot = unread messages, on top of any of those. The mic and speaker beside it mirror the page's buttons:
    // mic dim = not in use, green = live, red = muted; speaker green = hearing, red = deafened
    let dot = !state.unread.isEmpty
    let color: NSColor? = !state.knocks.isEmpty ? .systemOrange : state.inCall ? .systemGreen : nil
    status.button?.image = Person.image(color: color, mic: micGlyph, speaker: speakerGlyph, dot: dot)
    let total = state.unread.reduce(0) { $0 + $1.count }
    NSApp.dockTile.badgeLabel = total > 0 ? "\(total)" : nil // visible while the window is open (in the Dock); never bounces
    status.button?.appearsDisabled = offline
    status.button?.toolTip = state.knocks.first?.text
      ?? (state.unread.isEmpty ? nil : "Unread messages from " + state.unread.map(\.name).joined(separator: ", "))
      ?? (offline ? "Can't reach \(host)" : state.inCall ? "In a call" + voiceNote : appName)
  }

  /// The person knocks a few times on the icon, so a knock is noticeable even in quiet mode.
  func ring() {
    ringing?.invalidate()
    var n = 0
    ringing = Timer.scheduledTimer(withTimeInterval: 0.18, repeats: true) { [weak self] t in
      guard let self else { return t.invalidate() }
      n += 1
      self.status.button?.image = Person.image(n % 2 == 1 ? Person.knocking : Person.standing, color: .systemOrange, mic: self.micGlyph, speaker: self.speakerGlyph)
      if n >= 8 { t.invalidate(); self.renderIcon() }
    }
  }

  @objc func updateClicked() {
    guard !offline else { // the download would fail halfway; say why instead
      let a = NSAlert(); a.messageText = "Can't update while offline"; a.informativeText = "Connect to \(host) (check NetBird), then try again."
      NSApp.activate(); a.runModal(); return
    }
    updater.start(in: web)
  }

  func openChat(_ id: String) {
    if window.isVisible { showWindow() } else { showPopover() }
    js("__deckNative.openChat(\(json(id)))")
  }
  @objc func openChatClicked(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { openChat(id) } }

  func renderUpdate() {
    updateButton?.isHidden = updater.available == nil
    updateButton?.title = updater.busy ? "Updating…" : "Update"
    updateButton?.isEnabled = !updater.busy
    updateButton?.toolTip = updater.available.map { "Update to \($0.version); the app restarts" }
  }

  func js(_ code: String) { web.evaluateJavaScript(code) }

  // MARK: page → app (client/src/native.ts)

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let m = message.body as? [String: Any] else { return }
    // Only the main page may control personal notifications, never a subframe or another origin.
    if (m["type"] as? String)?.hasPrefix("wellness") == true {
      guard message.frameInfo.isMainFrame, let page = web.url, let configured = URL(string: url),
            page.scheme == configured.scheme, page.host == configured.host, page.port == configured.port else { return }
      switch m["type"] as? String {
      case "wellness": wellness.sync(m)
      case "wellnessPermission": wellness.requestPermission()
      case "wellnessSettings":
        if let settings = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(settings) }
      default: break
      }
      return
    }
    if m["type"] as? String == "macApp" { updater.offer(m); return updateIfIdle() }
    guard m["type"] as? String == "state" else { return }
    let old = state
    state = DeckState(connected: m["connected"] as? Bool ?? false, inCall: m["inCall"] as? Bool ?? false,
                      busy: m["busy"] as? Bool ?? false,
                      mic: m["mic"] as? String ?? "off", speaker: m["speaker"] as? String ?? "off",
                      knocks: (m["knocks"] as? [[String: Any]] ?? []).compactMap { k in
                        (k["id"] as? String).map { ($0, k["text"] as? String ?? "Someone is knocking") } },
                      meetings: (m["meetings"] as? [[String: Any]] ?? []).compactMap { e in
                        (e["id"] as? String).map { ($0, e["text"] as? String ?? "A meeting is starting") } },
                      unread: (m["unread"] as? [[String: Any]] ?? []).compactMap { u in
                        (u["id"] as? String).map { ($0, u["name"] as? String ?? "Someone", u["count"] as? Int ?? 1) } })
    trackSocket(connected: state.connected)
    renderIcon()
    updateCard(old)
    updateIfIdle()
  }

  /// The app is usually hidden in the menu bar, where App Nap and timer coalescing make call audio choppy.
  func holdForCall(_ on: Bool) {
    if on, callActivity == nil {
      callActivity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical, .idleSystemSleepDisabled], reason: "Voice call")
    } else if !on, let a = callActivity {
      ProcessInfo.processInfo.endActivity(a); callActivity = nil
    }
  }

  /// Updates install themselves when you won't notice the restart: not in a call, no popover or window open.
  func updateIfIdle() {
    guard updater.available != nil, pageOK, state.connected, !state.inCall, state.knocks.isEmpty,
          !popover.isShown, !window.isVisible else { return }
    updater.startAutomatically(in: web)
  }

  /// New knock → card under the icon (or just a ringing icon when busy / the Deck is already in front).
  /// Answering happens in the page, so the call (and voice) starts from a click there.
  /// A meeting's heads-up gets the same card even when busy: it's the nudge to wrap up a call or come back.
  func updateCard(_ old: DeckState) {
    let fresh = state.knocks.filter { k in !old.knocks.contains { $0.id == k.id } }
    let freshMeeting = state.meetings.filter { e in !old.meetings.contains { $0.id == e.id } }.last
    let deckInFront = popover.isShown || (window.isVisible && NSApp.isActive)
    if let k = fresh.last {
      ring()
      if popOnKnock && !state.busy && !deckInFront, let b = status.button { return card.show(id: k.id, text: k.text, from: b) }
    }
    if let e = freshMeeting {
      ring()
      if popOnKnock && !deckInFront && card.knockId == nil, let b = status.button { return card.showMeeting(key: e.id, text: e.text, from: b) }
    }
    if let id = card.knockId, !state.knocks.contains(where: { $0.id == id }) { card.close() } // answered elsewhere, or expired
    if let key = card.meetingKey, !state.meetings.contains(where: { $0.id == key }) { card.close() } // Go, Later in the page, or over
  }

  // MARK: web view plumbing

  // Microphone for voice calls: the page asks, macOS shows its own prompt the first time.
  func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
               type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(type == .microphone ? .grant : .deny)
  }

  // <input type=file> (Slides in presentation mode): WKWebView draws no picker of its own.
  func webView(_ w: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    if #available(macOS 11.0, *) { panel.allowedContentTypes = [.png, .jpeg, .pdf] }
    else { panel.allowedFileTypes = ["png", "jpg", "jpeg", "pdf"] }
    if let host = w.window, host.isVisible {
      panel.beginSheetModal(for: host) { completionHandler($0 == .OK ? panel.urls : nil) }
    } else {
      // Popover: it's transient and would close when the panel takes focus, taking the web view (and the page's file input) with it.
      let behavior = popover.behavior
      popover.behavior = .applicationDefined
      NSApp.activate()
      let ok = panel.runModal() == .OK
      popover.behavior = behavior
      completionHandler(ok ? panel.urls : nil)
    }
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

  /// Shown while the window is open (the app is in the Dock then); copy/paste shortcuts need the Edit menu always.
  func editMenu() -> NSMenu {
    let main = NSMenu(), app = NSMenuItem(), a = NSMenu(title: appName)
    a.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    a.addItem(.separator())
    a.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    a.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    app.submenu = a; main.addItem(app)
    let edit = NSMenuItem(), m = NSMenu(title: "Edit")
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

func json(_ s: String) -> String {
  String(data: try! JSONEncoder().encode(s), encoding: .utf8)!
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
