// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "AppShaders",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "AppShaders", targets: ["AppShaders"])
  ],
  dependencies: [
    .package(name: "C2GeneratedCompute", path: "../RuntimePrototype")
  ],
  targets: [
    .target(
      name: "AppShaders",
      dependencies: [
        .product(name: "VGPUABI", package: "C2GeneratedCompute")
      ],
      resources: [.process("Resources")]
    )
  ]
)
