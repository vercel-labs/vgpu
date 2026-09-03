// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "C0LinkingFixture",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "VGPUABI", targets: ["VGPUABI"]),
    .library(name: "VGPUCore", targets: ["VGPUCore"]),
    .library(name: "VGPUResources", targets: ["VGPUResources"]),
    .library(name: "VGPURender", targets: ["VGPURender"]),
    .library(name: "VGPUCompute", targets: ["VGPUCompute"]),
    .library(name: "AppPrograms", targets: ["AppPrograms"]),
    .library(
      name: "C0MetalCoreBundle",
      targets: ["VGPUABI", "VGPUCore", "PhysicalMetalCore"]
    ),
    .library(
      name: "C0MetalRenderBundle",
      targets: [
        "VGPUABI",
        "VGPUCore",
        "VGPUResources",
        "VGPURender",
        "PhysicalMetalCore",
        "PhysicalMetalResource",
        "PhysicalMetalRender",
      ]
    ),
    .library(
      name: "C0MetalComputeBundle",
      targets: [
        "VGPUABI",
        "VGPUCore",
        "VGPUResources",
        "VGPUCompute",
        "PhysicalMetalCore",
        "PhysicalMetalResource",
        "PhysicalMetalCompute",
      ]
    ),
    .executable(name: "ContextUnified", targets: ["ContextUnified"]),
    .executable(name: "ContextPhysical", targets: ["ContextPhysical"]),
    .executable(name: "EffectPhysical", targets: ["EffectPhysical"]),
    .executable(name: "ComputePhysical", targets: ["ComputePhysical"]),
  ],
  targets: [
    .target(name: "VGPUABI"),
    .target(name: "BackendSPI", dependencies: ["VGPUABI"]),
    .target(name: "VGPUCore", dependencies: ["VGPUABI", "BackendSPI"]),
    .target(name: "VGPUResources", dependencies: ["VGPUCore", "BackendSPI"]),
    .target(name: "VGPURender", dependencies: ["VGPUABI", "VGPUCore", "BackendSPI"]),
    .target(name: "VGPUCompute", dependencies: ["VGPUABI", "VGPUCore", "BackendSPI"]),
    .target(name: "AppPrograms", dependencies: ["VGPUABI"]),
    .target(name: "CapabilityPayloads", publicHeadersPath: "include"),
    .target(
      name: "UnifiedMetal",
      dependencies: ["VGPUCore", "BackendSPI", "CapabilityPayloads"],
      linkerSettings: [.linkedFramework("Metal")]
    ),
    .target(
      name: "PhysicalMetalCore",
      dependencies: ["VGPUCore", "BackendSPI", "CapabilityPayloads"],
      linkerSettings: [.linkedFramework("Metal")]
    ),
    .target(
      name: "PhysicalMetalResource",
      dependencies: ["PhysicalMetalCore", "BackendSPI", "CapabilityPayloads"]
    ),
    .target(
      name: "PhysicalMetalRender",
      dependencies: [
        "PhysicalMetalCore",
        "PhysicalMetalResource",
        "BackendSPI",
        "CapabilityPayloads",
      ]
    ),
    .target(
      name: "PhysicalMetalCompute",
      dependencies: [
        "PhysicalMetalCore",
        "PhysicalMetalResource",
        "BackendSPI",
        "CapabilityPayloads",
      ]
    ),
    .executableTarget(
      name: "ContextUnified",
      dependencies: ["VGPUCore", "UnifiedMetal"]
    ),
    .executableTarget(
      name: "ContextPhysical",
      dependencies: ["VGPUCore", "PhysicalMetalCore"]
    ),
    .executableTarget(
      name: "EffectPhysical",
      dependencies: [
        "VGPUCore",
        "VGPUResources",
        "VGPURender",
        "PhysicalMetalCore",
        "PhysicalMetalRender",
        "AppPrograms",
      ]
    ),
    .executableTarget(
      name: "ComputePhysical",
      dependencies: [
        "VGPUCore",
        "VGPUResources",
        "VGPUCompute",
        "PhysicalMetalCore",
        "PhysicalMetalCompute",
        "AppPrograms",
      ]
    ),
  ]
)
