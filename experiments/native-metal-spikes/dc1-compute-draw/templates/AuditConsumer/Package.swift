// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "AuditConsumer",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(name: "AppShaders", path: "../AppShaders"),
    .package(name: "RuntimePrototype", path: "../RuntimePrototype"),
  ],
  targets: [
    .executableTarget(
      name: "AuditConsumer",
      dependencies: [
        .product(name: "AppShaders", package: "AppShaders"),
        .product(name: "VGPUMetalCompute", package: "RuntimePrototype"),
        .product(name: "VGPUMetalRender", package: "RuntimePrototype"),
        .product(name: "VGPUTesting", package: "RuntimePrototype"),
      ]
    )
  ]
)
