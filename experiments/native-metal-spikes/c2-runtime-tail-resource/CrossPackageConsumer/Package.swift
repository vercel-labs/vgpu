// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CrossPackageConsumer",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(path: "..")
  ],
  targets: [
    .target(
      name: "ExternalGeneratedFixture",
      dependencies: [
        .product(name: "VGPUABI", package: "c2-runtime-tail-resource")
      ]
    ),
    .executableTarget(
      name: "CrossPackageConsumer",
      dependencies: [
        "ExternalGeneratedFixture",
        .product(name: "VGPUABI", package: "c2-runtime-tail-resource"),
      ]
    )
  ]
)
