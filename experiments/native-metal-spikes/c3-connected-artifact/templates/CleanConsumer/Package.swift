// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CleanConsumer",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(name: "AppShaders", path: "../AppShaders"),
    .package(name: "C2GeneratedCompute", path: "../RuntimePrototype"),
  ],
  targets: [
    .executableTarget(
      name: "CleanConsumer",
      dependencies: [
        .product(name: "AppShaders", package: "AppShaders"),
        .product(name: "VGPUMetalCompute", package: "C2GeneratedCompute"),
      ]
    )
  ]
)
