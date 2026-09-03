// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "C2BindingABI",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "C2ABIProbe", targets: ["C2ABIProbe"]),
  ],
  targets: [
    .executableTarget(name: "C2ABIProbe"),
  ]
)
