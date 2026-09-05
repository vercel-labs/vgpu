// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "C2RuntimeTailResource",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "VGPUABI", targets: ["VGPUABI"]),
    .library(name: "_VGPUBackendSPI", targets: ["_VGPUBackendSPI"]),
    .library(name: "VGPUResources", targets: ["VGPUResources"]),
    .library(name: "GeneratedFixture", targets: ["GeneratedFixture"]),
    .executable(name: "RecordingProbe", targets: ["RecordingProbe"]),
    .executable(name: "MetalProbe", targets: ["MetalProbe"]),
  ],
  targets: [
    .target(name: "VGPUABI"),
    .target(name: "_VGPUBackendSPI", dependencies: ["VGPUABI"]),
    .target(
      name: "VGPUResources",
      dependencies: ["VGPUABI", "_VGPUBackendSPI"]
    ),
    .target(name: "GeneratedFixture", dependencies: ["VGPUABI"]),
    .executableTarget(
      name: "RecordingProbe",
      dependencies: [
        "VGPUABI",
        "_VGPUBackendSPI",
        "VGPUResources",
        "GeneratedFixture",
      ]
    ),
    .executableTarget(
      name: "MetalProbe",
      dependencies: [
        "VGPUABI",
        "_VGPUBackendSPI",
        "VGPUResources",
        "GeneratedFixture",
      ],
      linkerSettings: [.linkedFramework("Metal")]
    ),
  ]
)
