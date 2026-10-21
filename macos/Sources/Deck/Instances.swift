// The list of instances (the Instance menu, the Settings table). The built-in ones seed it; the user's edits
// live in defaults, so a dev build and the installed app each keep their own.
import Foundation

struct Instance: Equatable { var name: String; var url: String }

enum Instances {
  static let prod = "https://voffice.t1a.io"
  static let builtIn = [
    Instance(name: "prod", url: prod),
    Instance(name: "andr", url: "https://voffice-andr.pub.t1a.cloud"),
    Instance(name: "var", url: "https://voffice-var.pub.t1a.cloud"),
    Instance(name: "iva", url: "https://voffice-iva.pub.t1a.cloud"),
    Instance(name: "demo", url: "https://voffice-demo.pub.t1a.cloud"),
    Instance(name: "local dev", url: "http://localhost:5173"),
  ]
  static var all: [Instance] {
    get {
      guard let raw = UserDefaults.standard.array(forKey: "instances") as? [[String: String]] else { return builtIn }
      let list = raw.compactMap { d in d["url"].map { Instance(name: d["name"] ?? $0, url: $0) } }
      return list.isEmpty ? builtIn : list
    }
    set { UserDefaults.standard.set(newValue.map { ["name": $0.name, "url": $0.url] }, forKey: "instances") }
  }
  static func reset() { UserDefaults.standard.removeObject(forKey: "instances") }
  static func name(of url: String) -> String { all.first { $0.url == url }?.name ?? (URL(string: url)?.host ?? url) }
  static func valid(_ url: String) -> Bool { URL(string: url).map { $0.scheme == "http" || $0.scheme == "https" } == true && URL(string: url)?.host != nil }
}
