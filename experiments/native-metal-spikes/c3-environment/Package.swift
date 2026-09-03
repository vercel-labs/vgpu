// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "C3EnvironmentProbe",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .executable(name: "C3EnvironmentProbe", targets: ["C3EnvironmentProbe"]),
  ],
  targets: [
    .executableTarget(name: "C3EnvironmentProbe"),
  ]
)
