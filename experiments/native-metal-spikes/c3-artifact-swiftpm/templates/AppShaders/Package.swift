// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "AppShaders",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .library(name: "AppShaders", targets: ["AppShaders"]),
    .executable(name: "AppShadersC3MetalProbe", targets: ["AppShadersC3MetalProbe"]),
  ],
  dependencies: [
    .package(name: "RuntimeStub", path: "../RuntimeStub")
  ],
  targets: [
    .target(
      name: "AppShaders",
      dependencies: [
        .product(name: "VGPUABI", package: "RuntimeStub")
      ],
      resources: [
        .process("Resources")
      ]
    ),
    .executableTarget(
      name: "AppShadersC3MetalProbe",
      dependencies: ["AppShaders"],
      linkerSettings: [
        .linkedFramework("Metal")
      ]
    ),
    .testTarget(
      name: "AppShadersTests",
      dependencies: ["AppShaders"]
    ),
  ],
  swiftLanguageModes: [.v6]
)
