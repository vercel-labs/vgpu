// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "C2GeneratedCompute",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "VGPUABI", targets: ["VGPUABI"]),
    .library(name: "VGPUCore", targets: ["VGPUCore"]),
    .library(name: "VGPUResources", targets: ["VGPUResources"]),
    .library(name: "VGPUCompute", targets: ["VGPUCompute"]),
    .library(name: "GeneratedFixture", targets: ["GeneratedFixture"]),
    .executable(name: "RecordingProbe", targets: ["RecordingProbe"]),
    .executable(name: "MetalProbe", targets: ["MetalProbe"]),
  ],
  targets: [
    .target(name: "VGPUABI"),
    .target(name: "_VGPUBackendSPI", dependencies: ["VGPUABI"]),
    .target(
      name: "VGPUCore",
      dependencies: ["VGPUABI", "_VGPUBackendSPI"]
    ),
    .target(
      name: "VGPUResources",
      dependencies: ["VGPUABI", "VGPUCore", "_VGPUBackendSPI"]
    ),
    .target(
      name: "VGPUCompute",
      dependencies: ["VGPUABI", "VGPUCore", "_VGPUBackendSPI"]
    ),
    .target(name: "GeneratedFixture", dependencies: ["VGPUABI"]),
    .target(
      name: "_VGPUMetalCoreImpl",
      dependencies: ["_VGPUBackendSPI"],
      linkerSettings: [.linkedFramework("Metal")]
    ),
    .target(
      name: "_VGPUMetalResourcesImpl",
      dependencies: ["VGPUABI", "_VGPUBackendSPI", "_VGPUMetalCoreImpl"],
      linkerSettings: [.linkedFramework("Metal")]
    ),
    .target(
      name: "_VGPUMetalComputeImpl",
      dependencies: [
        "VGPUABI",
        "_VGPUBackendSPI",
        "_VGPUMetalCoreImpl",
        "_VGPUMetalResourcesImpl",
      ],
      linkerSettings: [.linkedFramework("Metal")]
    ),
    .target(
      name: "VGPUTesting",
      dependencies: [
        "VGPUABI",
        "VGPUCore",
        "_VGPUBackendSPI",
        "_VGPUMetalCoreImpl",
        "_VGPUMetalResourcesImpl",
        "_VGPUMetalComputeImpl",
      ],
      linkerSettings: [.linkedFramework("Metal")]
    ),
    .executableTarget(
      name: "RecordingProbe",
      dependencies: [
        "VGPUABI",
        "VGPUCore",
        "VGPUResources",
        "VGPUCompute",
        "GeneratedFixture",
        "_VGPUBackendSPI",
      ]
    ),
    .executableTarget(
      name: "MetalProbe",
      dependencies: [
        "VGPUABI",
        "VGPUCore",
        "VGPUResources",
        "VGPUCompute",
        "GeneratedFixture",
        "VGPUTesting",
      ]
    ),
  ]
)
