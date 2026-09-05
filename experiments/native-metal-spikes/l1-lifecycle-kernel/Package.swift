// swift-tools-version: 6.0

import PackageDescription

let strictConcurrency: [SwiftSetting] = [
  .enableUpcomingFeature("StrictConcurrency")
]

let package = Package(
  name: "L1LifecycleKernel",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "LifecycleKernel", targets: ["LifecycleKernel"]),
    .executable(name: "LifecycleProbe", targets: ["LifecycleProbe"]),
  ],
  targets: [
    .target(
      name: "LifecycleKernel",
      swiftSettings: strictConcurrency
    ),
    .executableTarget(
      name: "LifecycleProbe",
      dependencies: ["LifecycleKernel"],
      swiftSettings: strictConcurrency + [
        .unsafeFlags(["-parse-as-library"])
      ]
    ),
  ]
)
