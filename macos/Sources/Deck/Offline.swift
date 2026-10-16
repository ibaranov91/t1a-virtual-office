// Staying up when the network isn't: NetBird down, Wi-Fi gone, the proxy half-up, a sleeping Mac, a crashed
// WebContent process. A failed page load shows a native "can't reach" card over the web view and retries with
// backoff; a network change or wake retries at once. A page that did load keeps running when only its socket
// drops: the page reconnects by itself (client/src/net.ts), we just nudge it.
import AppKit
import Network
import WebKit

/// The card that covers the web view when the page couldn't load. It's a subview of the web view, so it moves
/// with it between the popover, the window and the desktop.
final class OfflineView: NSView {
  let title = NSTextField(labelWithString: "")
  let hint = NSTextField(wrappingLabelWithString: "")
  let detail = NSTextField(wrappingLabelWithString: "")
  let countdown = NSTextField(labelWithString: "")
  let retry = NSButton(title: "Retry now", target: nil, action: nil)
  let instance = NSButton(title: "Instance…", target: nil, action: nil)

  init() {
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    let icon = NSImageView(image: Person.image(color: .secondaryLabelColor, pixel: 4))
    title.font = .boldSystemFont(ofSize: 16); title.alignment = .center
    for (f, size) in [(hint, 13.0), (detail, 11.0)] {
      f.font = .systemFont(ofSize: size); f.alignment = .center; f.textColor = .secondaryLabelColor; f.preferredMaxLayoutWidth = 340
    }
    detail.textColor = .tertiaryLabelColor
    countdown.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular); countdown.textColor = .tertiaryLabelColor
    retry.keyEquivalent = "\r"; retry.bezelColor = .systemOrange
    let buttons = NSStackView(views: [instance, retry]); buttons.spacing = 8
    let stack = NSStackView(views: [icon, title, hint, detail, buttons, countdown])
    stack.orientation = .vertical; stack.spacing = 8; stack.alignment = .centerX
    stack.setCustomSpacing(16, after: icon); stack.setCustomSpacing(16, after: detail)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: centerXAnchor), stack.centerYAnchor.constraint(equalTo: centerYAnchor),
                                 stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -32)])
  }
  required init?(coder: NSCoder) { fatalError() }
  override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor } // light/dark switch
  override var wantsUpdateLayer: Bool { true }
}

/// Seconds between automatic retries: quick at first (a blip), then every 30 s.
let retryDelays: [TimeInterval] = [2, 5, 10, 30]

extension AppDelegate {
  var host: String { URL(string: url)?.host ?? url }
  /// The menu bar shows "offline" when the page never loaded, or its socket has been down for a while.
  var offline: Bool { !pageOK || (socketDownSince.map { Date().timeIntervalSince($0) > 10 } ?? false) }

  func startWatchingNetwork() {
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      guard path.status == .satisfied else { return }
      DispatchQueue.main.async { self?.networkChanged() } // also fires when NetBird's tunnel comes up
    }
    monitor.start(queue: .global(qos: .utility))
    pathMonitor = monitor
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self?.networkChanged() } // Wi-Fi needs a moment after wake
    }
  }

  /// The network may be back: retry a failed load now, or tell a loaded page to reconnect its socket now.
  func networkChanged() {
    networkDebounce?.invalidate()
    networkDebounce = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
      guard let self else { return }
      if self.loadError != nil { self.retryLoad() } else if self.pageOK { self.js("window.__deckNative?.wake?.()") }
    }
  }

  // MARK: page load lifecycle (WKNavigationDelegate)

  func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) {
    loadTimeout?.invalidate()
    loadTimeout = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
      guard let self, w.isLoading else { return }
      w.stopLoading()
      self.loadFailed("It didn't answer within 20 seconds.")
    }
  }

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    loadTimeout?.invalidate()
    pageOK = true; loadError = nil; attempt = 0
    retryTimer?.invalidate(); hideOffline(); renderIcon()
  }

  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { navigationFailed(e) }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { navigationFailed(e) }

  /// The proxy is up but the server isn't (502/503/504 while it restarts): retry instead of showing its error page.
  func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    if r.isForMainFrame, let http = r.response as? HTTPURLResponse, http.statusCode >= 500 {
      decisionHandler(.cancel)
      return loadFailed("The server answered \(http.statusCode). It may be restarting.")
    }
    decisionHandler(.allow)
  }

  /// WebKit's content process died (memory pressure, a GPU reset, a long sleep): the view goes blank. Reload,
  /// and if it keeps dying, back off like a failed load.
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    NSLog("The Deck: web content process terminated")
    pageOK = false; state = DeckState(); renderIcon()
    if let last = lastCrash, Date().timeIntervalSince(last) < 30 { loadFailed("The page stopped unexpectedly.") }
    else { load() }
    lastCrash = Date()
  }

  func navigationFailed(_ e: Error) {
    let ns = e as NSError
    if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }   // a newer load replaced it
    if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }               // we cancelled it (5xx above)
    loadFailed(ns.localizedDescription)
  }

  // MARK: offline card and retries

  func loadFailed(_ why: String) {
    loadTimeout?.invalidate()
    pageOK = false; loadError = why
    state = DeckState() // the page is gone: no stale knocks, call or unread on the icon
    let delay = retryDelays[min(attempt, retryDelays.count - 1)]
    attempt += 1
    retryAt = Date().addingTimeInterval(delay)
    retryTimer?.invalidate()
    retryTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tickRetry() }
    showOffline()
    renderIcon()
  }

  func tickRetry() {
    guard let at = retryAt else { return }
    let left = Int(at.timeIntervalSinceNow.rounded(.up))
    if left <= 0 { return retryLoad() }
    offlineView?.countdown.stringValue = "Trying again in \(left) s"
  }

  @objc func retryLoad() {
    retryTimer?.invalidate(); retryAt = nil
    offlineView?.countdown.stringValue = "Connecting…"
    load()
  }

  func showOffline() {
    let v = offlineView ?? {
      let v = OfflineView()
      v.retry.target = self; v.retry.action = #selector(retryLoad)
      v.instance.target = self; v.instance.action = #selector(offlineInstanceClicked(_:))
      offlineView = v
      return v
    }()
    v.title.stringValue = "Can't reach \(host)"
    v.hint.stringValue = "Check that NetBird is connected and you're online. The Deck keeps trying on its own."
    v.detail.stringValue = loadError ?? ""
    tickRetry()
    if v.superview !== web { fill(web, with: v); web.addSubview(v, positioned: .above, relativeTo: nil) }
  }

  func hideOffline() { offlineView?.removeFromSuperview() }

  @objc func offlineInstanceClicked(_ sender: NSButton) {
    buildMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
  }

  /// Socket state from the page: remember since when it's been down, and re-render once "a while" has passed.
  func trackSocket(connected: Bool) {
    if connected { socketDownSince = nil; socketTimer?.invalidate(); return }
    guard socketDownSince == nil else { return }
    socketDownSince = Date()
    socketTimer = Timer.scheduledTimer(withTimeInterval: 11, repeats: false) { [weak self] _ in self?.renderIcon() }
  }
}
