// Self-update. The page tells us what the instance serves (GET /api/mac → build, sha256); when that
// differs from our DeckBuild we offer "Update". The zip comes through the web view's own session (so it
// gets past the NetBird PIN / SSO like the page did), must match the sha256, and must be signed by the
// same identity as this app. Then we swap the bundle in place and relaunch.
import AppKit
import CryptoKit
import Security
import WebKit

struct UpdateError: Error { let message: String }

final class Updater: NSObject, WKDownloadDelegate {
  private(set) var available: (build: String, version: String, sha256: String)?
  private(set) var busy = false
  var onChange: () -> Void = {}
  private var zip: URL?
  private var auto = false              // started on its own: fail quietly, leave the Update button
  private var autoTried = Set<String>() // never retry a build on its own after it failed once

  var ownBuild: String? { Bundle.main.object(forInfoDictionaryKey: "DeckBuild") as? String }

  func offer(_ m: [String: Any]) {
    // Local builds (macos/build.sh without --dist) would otherwise "update" to whatever the instance serves.
    if Bundle.main.object(forInfoDictionaryKey: "DeckDev") as? Bool == true { return }
    // Another instance's app (e.g. prod's app pointed at iva): not ours to install.
    if let id = m["bundleId"] as? String, id != Bundle.main.bundleIdentifier { return }
    guard let build = m["build"] as? String, let sha = m["sha256"] as? String, let own = ownBuild, build != own else {
      if available != nil { available = nil; onChange() }
      return
    }
    available = (build, m["version"] as? String ?? build, sha)
    onChange()
  }

  /// Install without asking (the caller checks you're idle). Once per build.
  func startAutomatically(in web: WKWebView) {
    guard let a = available, !busy, !autoTried.contains(a.build) else { return }
    autoTried.insert(a.build)
    start(in: web, auto: true)
  }

  func start(in web: WKWebView, auto: Bool = false) {
    self.auto = auto
    guard available != nil, !busy, let page = web.url, var c = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return }
    // Run straight from a quarantined download, macOS runs a read-only copy we can't replace.
    if Bundle.main.bundlePath.contains("/AppTranslocation/") { return fail("Move The Deck to Applications, open it from there, then update.") }
    c.path = "/api/mac/The-Deck.zip"; c.query = nil; c.fragment = nil
    guard let url = c.url else { return }
    busy = true; onChange()
    web.startDownload(using: URLRequest(url: url)) { $0.delegate = self }
  }

  func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename: String) async -> URL? {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("deck-update-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    zip = dir.appendingPathComponent("The-Deck.zip")
    return zip
  }

  func downloadDidFinish(_ d: WKDownload) {
    do { try install() } catch let e as UpdateError { fail(e.message) } catch { fail(error.localizedDescription) }
  }

  func download(_ d: WKDownload, didFailWithError error: Error, resumeData: Data?) { fail("Download failed: \(error.localizedDescription)") }

  private func install() throws {
    guard let zip, let want = available?.sha256 else { throw UpdateError(message: "Nothing to install.") }
    let got = SHA256.hash(data: try Data(contentsOf: zip)).map { String(format: "%02x", $0) }.joined()
    guard got == want else { throw UpdateError(message: "The download didn't match its checksum. Try again.") }
    let dir = zip.deletingLastPathComponent()
    try run("/usr/bin/ditto", "-x", "-k", zip.path, dir.path)
    guard let new = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
      .first(where: { $0.pathExtension == "app" }) else { throw UpdateError(message: "The download has no app in it.") }
    try checkSigner(new)
    try? run("/usr/bin/xattr", "-dr", "com.apple.quarantine", new.path) // WebKit marks downloads; we verified hash + signer
    let dest = Bundle.main.bundleURL
    _ = try FileManager.default.replaceItemAt(dest, withItemAt: new)
    let relaunch = Process()
    relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
    relaunch.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\" --args --updated", dest.path] // --updated: don't pop open
    try relaunch.run()
    NSApp.terminate(nil)
  }

  /// The new app must satisfy this app's designated requirement (same bundle id + same signing certificate).
  /// Ad-hoc builds can't be checked that way (their requirement is their own hash), so only the sha256 applies.
  private func checkSigner(_ app: URL) throws {
    var me: SecCode?, meStatic: SecStaticCode?, req: SecRequirement?, info: CFDictionary?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me, SecCodeCopyStaticCode(me, [], &meStatic) == errSecSuccess, let meStatic,
          SecCodeCopySigningInformation(meStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return }
    guard (info as? [String: Any])?[kSecCodeInfoCertificates as String] != nil else { return } // ad-hoc
    guard SecCodeCopyDesignatedRequirement(meStatic, [], &req) == errSecSuccess, let req else { return }
    var new: SecStaticCode?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &new) == errSecSuccess, let new,
          SecStaticCodeCheckValidity(new, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), req) == errSecSuccess
    else { throw UpdateError(message: "The update isn't signed by T1A Deck, so it wasn't installed.") }
  }

  private func run(_ tool: String, _ args: String...) throws {
    let p = Process(); p.executableURL = URL(fileURLWithPath: tool); p.arguments = args
    try p.run(); p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw UpdateError(message: "\(tool) failed (\(p.terminationStatus)).") }
  }

  private func fail(_ message: String) {
    busy = false; onChange()
    if auto { return NSLog("The Deck: automatic update failed: %@", message) }
    let a = NSAlert(); a.messageText = "Couldn't update The Deck"; a.informativeText = message
    NSApp.activate(); a.runModal()
  }
}
