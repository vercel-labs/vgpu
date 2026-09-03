// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CleanConsumer",
  platforms: [
    .macOS(.v14)
  ],
  dependencies: [
    .package(name: "AppShaders", path: "../AppShaders")
  ],
  targets: [
    .executableTarget(
      name: "CleanConsumer",
      dependencies: ["AppShaders"]
    )
  ],
  swiftLanguageModes: [.v6]
)
