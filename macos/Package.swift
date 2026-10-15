// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Deck",
  platforms: [.macOS(.v14)],
  targets: [.executableTarget(name: "Deck", path: "Sources/Deck")]
)
