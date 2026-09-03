// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "C0ExternalConsumer",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(name: "C0LinkingFixture", path: ".."),
  ],
  targets: [
    .executableTarget(
      name: "ExternalContext",
      dependencies: [
        .product(name: "C0MetalCoreBundle", package: "C0LinkingFixture"),
      ]
    ),
    .executableTarget(
      name: "ExternalEffect",
      dependencies: [
        .product(name: "C0MetalRenderBundle", package: "C0LinkingFixture"),
      ]
    ),
    .executableTarget(
      name: "ExternalCompute",
      dependencies: [
        .product(name: "C0MetalComputeBundle", package: "C0LinkingFixture"),
      ]
    ),
    .executableTarget(
      name: "ExternalFull",
      dependencies: [
        .product(name: "C0MetalRenderBundle", package: "C0LinkingFixture"),
        .product(name: "C0MetalComputeBundle", package: "C0LinkingFixture"),
      ]
    ),
  ]
)
