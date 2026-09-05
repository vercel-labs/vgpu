// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "C2GeneratedComputeConsumer",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(name: "C2GeneratedCompute", path: "..")
  ],
  targets: [
    .target(
      name: "ExternalGeneratedFixture",
      dependencies: [
        .product(name: "VGPUABI", package: "C2GeneratedCompute")
      ]
    ),
    .executableTarget(
      name: "CrossPackageConsumer",
      dependencies: [
        "ExternalGeneratedFixture",
        .product(name: "VGPUABI", package: "C2GeneratedCompute"),
        .product(name: "VGPUCore", package: "C2GeneratedCompute"),
        .product(name: "VGPUCompute", package: "C2GeneratedCompute"),
      ]
    ),
  ]
)
