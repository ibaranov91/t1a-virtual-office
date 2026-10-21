// Settings (⌘,): the OS-level things that belong to the app rather than the page. Tabs like any Mac app:
// General, Instances (an editable table), Notifications, Advanced. Game and audio settings stay in the web page,
// so they work in browsers too.
import AppKit
import ServiceManagement
import WebKit

final class SettingsWindow: NSWindowController, NSToolbarDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
  unowned let app: AppDelegate
  // General
  let login = NSButton(checkboxWithTitle: "Open at login", target: nil, action: nil)
  let loginNote = NSTextField(wrappingLabelWithString: "")
  let pin = NSPopUpButton(frame: .zero, pullsDown: false)
  let openAtLaunch = NSButton(checkboxWithTitle: "Show the window when the app starts", target: nil, action: nil)
  // Instances
  let table = NSTableView()
  let remove = NSButton(title: "", target: nil, action: nil)
  let use = NSButton(title: "Use", target: nil, action: nil)
  // Notifications
  let cards = NSButton(checkboxWithTitle: "Knock and meeting cards under the menu bar icon", target: nil, action: nil)
  // Advanced
  let keepAwake = NSButton(checkboxWithTitle: "Keep the Mac awake and the app responsive during calls", target: nil, action: nil)

  let tabs: [(id: NSToolbarItem.Identifier, title: String, symbol: String)] = [
    (.init("general"), "General", "gearshape"), (.init("instances"), "Instances", "server.rack"),
    (.init("notifications"), "Notifications", "bell"), (.init("advanced"), "Advanced", "wrench.and.screwdriver"),
  ]
  var panes: [NSToolbarItem.Identifier: NSView] = [:]
  var current: NSToolbarItem.Identifier?

  init(app: AppDelegate) {
    self.app = app
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    w.title = "\(appName) Settings"
    w.isReleasedWhenClosed = false
    w.center()
    super.init(window: w)
    let tb = NSToolbar(identifier: "settings")
    tb.delegate = self; tb.displayMode = .iconAndLabel; tb.allowsUserCustomization = false
    w.toolbar = tb
    w.toolbarStyle = .preference
    panes[tabs[0].id] = general(); panes[tabs[1].id] = instances(); panes[tabs[2].id] = notifications(); panes[tabs[3].id] = advanced()
    show(tab: tabs[0].id)
  }
  required init?(coder: NSCoder) { fatalError() }

  // MARK: toolbar tabs
  func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { tabs.map(\.id) }
  func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { tabs.map(\.id) }
  func toolbarSelectableItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { tabs.map(\.id) }
  func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
    guard let tab = tabs.first(where: { $0.id == id }) else { return nil }
    let i = NSToolbarItem(itemIdentifier: id)
    i.label = tab.title; i.image = NSImage(systemSymbolName: tab.symbol, accessibilityDescription: tab.title)
    i.target = self; i.action = #selector(tabClicked(_:))
    return i
  }
  @objc func tabClicked(_ sender: NSToolbarItem) { show(tab: sender.itemIdentifier) }
  func show(tab: NSToolbarItem.Identifier) {
    guard let w = window, let pane = panes[tab], current != tab else { return }
    current = tab
    w.toolbar?.selectedItemIdentifier = tab
    w.title = "\(tabs.first { $0.id == tab }?.title ?? "") · \(appName)"
    pane.layoutSubtreeIfNeeded()
    let size = pane.fittingSize
    let frame = w.frameRect(forContentRect: NSRect(x: 0, y: 0, width: max(520, size.width), height: size.height))
    var f = w.frame; f.origin.y += f.height - frame.height; f.size = frame.size // keep the top edge where it is
    w.contentView = pane
    w.setFrame(f, display: true, animate: w.isVisible)
    refresh()
  }

  // MARK: panes
  func label(_ s: String) -> NSTextField { let l = NSTextField(labelWithString: s); l.alignment = .right; return l }
  func note(_ s: String) -> NSTextField {
    let l = NSTextField(wrappingLabelWithString: s); l.font = .systemFont(ofSize: 11); l.textColor = .secondaryLabelColor; l.preferredMaxLayoutWidth = 340; return l
  }
  func form(_ rows: [[NSView]]) -> NSView {
    let grid = NSGridView(views: rows)
    grid.rowSpacing = 10; grid.columnSpacing = 12
    grid.column(at: 0).xPlacement = .trailing
    grid.column(at: 0).width = 120
    grid.translatesAutoresizingMaskIntoConstraints = false
    let root = NSView(); root.addSubview(grid)
    NSLayoutConstraint.activate([
      grid.topAnchor.constraint(equalTo: root.topAnchor, constant: 20), grid.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
      grid.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20), grid.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
    ])
    return root
  }
  func version() -> NSTextField {
    let l = NSTextField(labelWithString: appVersion); l.font = .systemFont(ofSize: 11); l.textColor = .tertiaryLabelColor; l.isSelectable = true; return l
  }

  func general() -> NSView {
    login.target = self; login.action = #selector(loginChanged)
    loginNote.font = .systemFont(ofSize: 11); loginNote.textColor = .systemOrange; loginNote.preferredMaxLayoutWidth = 340
    pin.addItems(withTitles: ["Not pinned", "On the desktop, under other windows", "On top of other windows"])
    pin.target = self; pin.action = #selector(pinChanged)
    openAtLaunch.target = self; openAtLaunch.action = #selector(openAtLaunchChanged)
    return form([
      [label("Login:"), login], [NSView(), loginNote],
      [label("Window:"), openAtLaunch],
      [label("Pinned window:"), pin],
      [NSView(), note("A pinned window has no title bar: drag it by the strip along its top edge, resize it from the edges.")],
      [NSView(), version()],
    ])
  }

  func instances() -> NSView {
    for (id, title, width) in [("name", "Name", 120.0), ("url", "URL", 300.0)] {
      let c = NSTableColumn(identifier: .init(id)); c.title = title; c.width = width; table.addTableColumn(c)
    }
    table.dataSource = self; table.delegate = self
    table.usesAlternatingRowBackgroundColors = true
    table.allowsEmptySelection = true
    table.doubleAction = #selector(useClicked); table.target = self
    let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.heightAnchor.constraint(equalToConstant: 190).isActive = true
    let add = NSButton(image: NSImage(systemSymbolName: "plus", accessibilityDescription: "Add")!, target: self, action: #selector(addClicked))
    remove.image = NSImage(systemSymbolName: "minus", accessibilityDescription: "Remove"); remove.target = self; remove.action = #selector(removeClicked)
    for b in [add, remove] { b.bezelStyle = .smallSquare; b.setButtonType(.momentaryPushIn) }
    use.target = self; use.action = #selector(useClicked)
    let reset = NSButton(title: "Reset to defaults", target: self, action: #selector(resetClicked))
    let bar = NSStackView(views: [add, remove, NSView(), reset, use]); bar.spacing = 6
    let stack = NSStackView(views: [scroll, bar, note("Double-click a row (or Use) to switch to it. Edit a name or URL in place; the current instance is marked ●.")])
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
    bar.widthAnchor.constraint(equalTo: scroll.widthAnchor).isActive = true
    return stack
  }

  func notifications() -> NSView {
    cards.target = self; cards.action = #selector(cardsChanged)
    return form([
      [label("Cards:"), cards],
      [NSView(), note("A knock or a meeting heads-up shows a small card under the icon with Open and Later. While you're away or in a call, only the icon lights up. Turned off, you still get the icon.")],
      [label("Wellness:"), NSButton(title: "Notification settings…", target: self, action: #selector(openNotificationSettings))],
      [NSView(), note("Personal reminders (stretch, water, eyes) come from the page as macOS notifications.")],
    ])
  }

  func advanced() -> NSView {
    keepAwake.target = self; keepAwake.action = #selector(keepAwakeChanged)
    let row = NSStackView(views: [
      NSButton(title: "Reload page", target: app, action: #selector(AppDelegate.reloadClicked)),
      NSButton(title: "Open in browser", target: app, action: #selector(AppDelegate.openInBrowser)),
      NSButton(title: "Sign out (clear page data)", target: self, action: #selector(clearData)),
    ])
    return form([
      [label("Calls:"), keepAwake],
      [NSView(), note("Hidden in the menu bar, App Nap can make voice choppy; this holds an activity while you're in a call.")],
      [label("Page:"), row],
      [label("Debug:"), note("Web Inspector: Safari ▸ Develop ▸ \(appName). A local build never self-updates.")],
    ])
  }

  // MARK: show / refresh
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
    (loginNote.superview as? NSGridView)?.cell(for: loginNote)?.row?.isHidden = loginNote.stringValue.isEmpty // the whole row, or the gap stays
    pin.selectItem(at: [.off, .desktop, .top].firstIndex(of: app.pinMode) ?? 0)
    openAtLaunch.state = app.openWindowAtLaunch ? .on : .off
    cards.state = app.popOnKnock ? .on : .off
    keepAwake.state = app.keepAwakeInCalls ? .on : .off
    table.reloadData()
    selectionChanged()
  }

  // MARK: actions
  @objc func loginChanged() {
    do { if login.state == .on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
    catch { let a = NSAlert(); a.messageText = "Couldn't change the login item"; a.informativeText = error.localizedDescription; a.runModal() }
    refresh()
  }
  @objc func cardsChanged() { app.popOnKnock = cards.state == .on }
  @objc func keepAwakeChanged() { app.keepAwakeInCalls = keepAwake.state == .on }
  @objc func openAtLaunchChanged() { app.openWindowAtLaunch = openAtLaunch.state == .on }
  @objc func pinChanged() { app.setPin([.off, .desktop, .top][max(0, pin.indexOfSelectedItem)]) }
  @objc func openNotificationSettings() {
    if let u = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(u) }
  }
  @objc func clearData() {
    let a = NSAlert(); a.messageText = "Sign out of \(Instances.name(of: app.url))?"
    a.informativeText = "Cookies, the session and cached files for every instance are removed, and the page reloads."
    a.addButton(withTitle: "Sign out"); a.addButton(withTitle: "Cancel")
    guard a.runModal() == .alertFirstButtonReturn else { return }
    WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { self.app.load() }
  }

  // MARK: instances table
  var list: [Instance] { Instances.all }
  func numberOfRows(in t: NSTableView) -> Int { list.count }
  func tableView(_ t: NSTableView, viewFor column: NSTableColumn?, row: Int) -> NSView? {
    guard let column, row < list.count else { return nil }
    let id = NSUserInterfaceItemIdentifier("cell-\(column.identifier.rawValue)")
    let cell = t.makeView(withIdentifier: id, owner: nil) as? NSTableCellView ?? {
      let c = NSTableCellView(); c.identifier = id
      let f = NSTextField(); f.isBordered = false; f.drawsBackground = false; f.isEditable = true; f.delegate = self
      f.translatesAutoresizingMaskIntoConstraints = false; f.lineBreakMode = .byTruncatingTail
      c.addSubview(f); c.textField = f
      NSLayoutConstraint.activate([f.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 2), f.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -2), f.centerYAnchor.constraint(equalTo: c.centerYAnchor)])
      return c
    }()
    let inst = list[row], isCurrent = inst.url == app.url
    cell.textField?.stringValue = column.identifier.rawValue == "name" ? (isCurrent ? "● " : "") + inst.name : inst.url
    cell.textField?.tag = row
    cell.textField?.font = isCurrent ? .boldSystemFont(ofSize: 13) : .systemFont(ofSize: 13)
    return cell
  }
  func tableViewSelectionDidChange(_ n: Notification) { selectionChanged() }
  func selectionChanged() {
    let row = table.selectedRow
    remove.isEnabled = row >= 0 && list.count > 1
    use.isEnabled = row >= 0 && list[row].url != app.url
  }
  /// A finished edit writes the cell back. The current-instance mark and whitespace are stripped from the name.
  func controlTextDidEndEditing(_ n: Notification) {
    guard let f = n.object as? NSTextField, let cell = f.superview else { return }
    let row = table.row(for: cell), column = table.column(for: cell)
    guard row >= 0, row < list.count, column >= 0 else { return }
    var all = Instances.all
    let text = f.stringValue.replacingOccurrences(of: "● ", with: "").trimmingCharacters(in: .whitespaces)
    if column == 0 { if !text.isEmpty { all[row].name = text } }
    else if Instances.valid(text) {
      let wasCurrent = all[row].url == app.url
      all[row].url = text
      Instances.all = all
      if wasCurrent { app.switchInstance(text) } else { table.reloadData() }
      return
    } else { NSSound.beep() }
    Instances.all = all
    table.reloadData()
  }
  @objc func addClicked() {
    var all = Instances.all; all.append(Instance(name: "new", url: "https://")); Instances.all = all
    table.reloadData()
    let row = all.count - 1
    table.selectRowIndexes([row], byExtendingSelection: false)
    table.editColumn(1, row: row, with: nil, select: true)
  }
  @objc func removeClicked() {
    let row = table.selectedRow; guard row >= 0, list.count > 1 else { return }
    var all = Instances.all
    let gone = all.remove(at: row); Instances.all = all
    if gone.url == app.url { app.switchInstance(all[0].url) }
    table.reloadData(); selectionChanged()
  }
  @objc func useClicked() {
    let row = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
    guard row >= 0, row < list.count, list[row].url != app.url else { return }
    app.switchInstance(list[row].url)
  }
  @objc func resetClicked() { Instances.reset(); table.reloadData(); selectionChanged() }
}

/// "0.1 (123) · build abcdef012345", plus "dev" for a local build (macos/build.sh without --dist).
var appVersion: String {
  let info = Bundle.main.infoDictionary ?? [:]
  let short = info["CFBundleShortVersionString"] as? String ?? "?", n = info["CFBundleVersion"] as? String ?? "?"
  let build = info["DeckBuild"] as? String ?? "?"
  let dev = info["DeckDev"] as? Bool == true ? " · dev build (never self-updates)" : ""
  return "\(appName) \(short) (\(n)) · build \(build)\(dev)"
}
/// The short form for the menu.
var appVersionShort: String {
  let info = Bundle.main.infoDictionary ?? [:]
  let dev = info["DeckDev"] as? Bool == true ? " · dev" : ""
  return "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?")) · \((info["DeckBuild"] as? String ?? "?").prefix(8))\(dev)"
}
