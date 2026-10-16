// One outstanding notification per personal timer. macOS owns the deadline while WebKit is hidden.
// Past deadlines are kept as read state, never rescheduled on reload (no burst after sleep).
import AppKit
import UserNotifications

struct WellnessNotice: Equatable {
  let kind: String, at: Double, title: String, body: String
  static let kinds = ["water", "stretch", "pomodoro"]
  init?(_ value: [String: Any]) {
    guard let kind = value["kind"] as? String, Self.kinds.contains(kind),
          let at = value["at"] as? Double, at.isFinite, at >= 0, at < 8.64e15,
          let title = value["title"] as? String, let body = value["body"] as? String else { return nil }
    self.kind = kind; self.at = at; self.title = String(title.prefix(100)); self.body = String(body.prefix(300))
  }
  var id: String { "deck.wellness.\(kind)" }
  var signature: String { "\(kind):\(at)" }
}

final class WellnessNotifications: NSObject, UNUserNotificationCenterDelegate {
  private let center = UNUserNotificationCenter.current()
  private let defaults = UserDefaults.standard
  private var owner = "", notices: [WellnessNotice] = [], revision = 0
  private var scheduled: [String: String] = [:]
  private var pendingOpen: (owner: String, kind: String)?
  private var pageReady = false
  var onOpen: (String) -> Void = { _ in }
  var onPermission: (String) -> Void = { _ in }
  var isInFront: () -> Bool = { false }

  override init() {
    super.init()
    owner = defaults.string(forKey: "wellness.owner") ?? ""
    scheduled = defaults.dictionary(forKey: "wellness.scheduled") as? [String: String] ?? [:]
    center.delegate = self // installed before launch finishes, including notification-triggered launches
  }

  func sync(_ message: [String: Any]) {
    guard let nextOwner = message["owner"] as? String,
          let raw = message["requests"] as? [[String: Any]], raw.count <= 3 else { return }
    let next = raw.compactMap(WellnessNotice.init)
    guard next.count == raw.count, Set(next.map(\.kind)).count == next.count else { return }
    if nextOwner != owner { clear(); owner = nextOwner; defaults.set(owner, forKey: "wellness.owner") }
    notices = nextOwner.isEmpty ? [] : next
    pageReady = !nextOwner.isEmpty
    revision += 1
    let ids = Set(notices.map(\.id)), removed = scheduled.keys.filter { !ids.contains($0) }
    center.removePendingNotificationRequests(withIdentifiers: Array(removed))
    center.removeDeliveredNotifications(withIdentifiers: Array(removed))
    for id in removed { scheduled.removeValue(forKey: id) }
    persist()
    refreshPermission()
    if let pending = pendingOpen, !owner.isEmpty {
      pendingOpen = nil
      if pending.owner == owner { onOpen(pending.kind) }
    }
  }

  func clear() {
    revision += 1
    let ids = WellnessNotice.kinds.map { "deck.wellness.\($0)" }
    center.removePendingNotificationRequests(withIdentifiers: ids)
    center.removeDeliveredNotifications(withIdentifiers: ids)
    notices = []; scheduled = [:]; owner = ""; pageReady = false
    defaults.set("", forKey: "wellness.owner"); persist()
  }
  func pageLoading() { pageReady = false }

  func requestPermission() {
    center.requestAuthorization(options: [.alert, .sound]) { [weak self] _, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let error { NSLog("Wellness notification authorization failed: %@", error.localizedDescription) }
        self.refreshPermission(failed: error != nil)
      }
    }
  }

  func refreshPermission(failed: Bool = false) {
    let currentRevision = revision
    center.getNotificationSettings { [weak self] settings in
      DispatchQueue.main.async {
        guard let self, currentRevision == self.revision else { return }
        let granted = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        self.onPermission(granted ? "granted" : settings.authorizationStatus == .denied ? "denied" : failed ? "error" : "unknown")
        if granted { self.schedule() }
      }
    }
  }

  private func persist() { defaults.set(scheduled, forKey: "wellness.scheduled") }
  private func schedule() {
    let now = Date().timeIntervalSince1970 * 1000
    for notice in notices where scheduled[notice.id] != notice.signature {
      center.removePendingNotificationRequests(withIdentifiers: [notice.id])
      center.removeDeliveredNotifications(withIdentifiers: [notice.id])
      scheduled[notice.id] = notice.signature
      guard notice.at > now else { continue } // the page shows an overdue reminder; no new system alert
      let content = UNMutableNotificationContent()
      content.title = notice.title; content.body = notice.body; content.sound = .default
      content.threadIdentifier = "deck.wellness"; content.userInfo = ["kind": notice.kind, "owner": owner]
      let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, (notice.at - now) / 1000), repeats: false)
      let request = UNNotificationRequest(identifier: notice.id, content: content, trigger: trigger)
      let requestOwner = owner
      center.add(request) { [weak self] error in
        guard error != nil else { return }
        DispatchQueue.main.async {
          guard let self, self.owner == requestOwner, self.scheduled[notice.id] == notice.signature else { return }
          NSLog("Wellness notification scheduling failed: %@", error!.localizedDescription)
          self.scheduled.removeValue(forKey: notice.id); self.persist(); self.onPermission("error")
        }
      }
    }
    persist()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    DispatchQueue.main.async { completionHandler(self.isInFront() ? [] : [.banner, .sound]) }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler completionHandler: @escaping () -> Void) {
    let info = response.notification.request.content.userInfo
    DispatchQueue.main.async {
      defer { completionHandler() }
      guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
            let kind = info["kind"] as? String, WellnessNotice.kinds.contains(kind), let owner = info["owner"] as? String else { return }
      // Wait for the signed-in page to identify its owner before opening anything (also handles cold launch).
      if self.pageReady && self.owner == owner { self.onOpen(kind) }
      else { self.pendingOpen = (owner, kind); self.onOpen("") } // cold launch: wait for page sync
    }
  }
}
