// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "RuntimeStub",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .library(name: "VGPUABI", targets: ["VGPUABI"])
  ],
  targets: [
    .target(name: "VGPUABI")
  ],
  swiftLanguageModes: [.v6]
)
