import CryptoKit
import Foundation
import VGPUABI

public struct AppShadersRuntimeSupport: Sendable {
  public var semanticSchemaVersions: ClosedRange<Int>
  public var metalProjectionABIs: ClosedRange<Int>
  public var generatedSwiftABIs: ClosedRange<Int>
  public var bindingLayoutABIs: ClosedRange<Int>
  public var vgpuABIVersions: ClosedRange<Int>
  public var bindingSlotsABIs: ClosedRange<Int>
  public var layoutModels: Set<String>
  public var bindingModels: Set<String>
  public var shaderInterfaceModels: Set<String>
  public var vertexBufferPolicyModels: Set<String>
  public var immediateDataLayoutModels: Set<String>
  public var storageBufferSizeModels: Set<String>

  public init(
    semanticSchemaVersions: ClosedRange<Int>,
    metalProjectionABIs: ClosedRange<Int>,
    generatedSwiftABIs: ClosedRange<Int>,
    bindingLayoutABIs: ClosedRange<Int>,
    vgpuABIVersions: ClosedRange<Int>,
    bindingSlotsABIs: ClosedRange<Int>,
    layoutModels: Set<String>,
    bindingModels: Set<String>,
    shaderInterfaceModels: Set<String>,
    vertexBufferPolicyModels: Set<String>,
    immediateDataLayoutModels: Set<String>,
    storageBufferSizeModels: Set<String>
  ) {
    self.semanticSchemaVersions = semanticSchemaVersions
    self.metalProjectionABIs = metalProjectionABIs
    self.generatedSwiftABIs = generatedSwiftABIs
    self.bindingLayoutABIs = bindingLayoutABIs
    self.vgpuABIVersions = vgpuABIVersions
    self.bindingSlotsABIs = bindingSlotsABIs
    self.layoutModels = layoutModels
    self.bindingModels = bindingModels
    self.shaderInterfaceModels = shaderInterfaceModels
    self.vertexBufferPolicyModels = vertexBufferPolicyModels
    self.immediateDataLayoutModels = immediateDataLayoutModels
    self.storageBufferSizeModels = storageBufferSizeModels
  }

  public static let fixtureSupported = AppShadersRuntimeSupport(
    semanticSchemaVersions: 1...1,
    metalProjectionABIs: 1...1,
    generatedSwiftABIs: 1...1,
    bindingLayoutABIs: 1...1,
    vgpuABIVersions: 1...1,
    bindingSlotsABIs: 1...1,
    layoutModels: ["wgsl-host-shareable-v1"],
    bindingModels: ["vgpu-metal-binding-slots-v1"],
    shaderInterfaceModels: ["vgpu-metal-shader-interface-v1"],
    vertexBufferPolicyModels: ["vgpu-metal-pipeline-local-vertex-buffer-slots-v1"],
    immediateDataLayoutModels: ["vgpu-metal-immediate-data-layout-v1"],
    storageBufferSizeModels: ["vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1"]
  )
}

public struct AppShadersDescriptor: Sendable {
  public var semanticSchemaVersion: Int
  public var metalProjectionABI: Int
  public var generatedSwiftABI: Int
  public var bindingLayoutABI: Int
  public var requiredVGPUABIVersion: Int
  public var bindingSlotsABI: Int
  public var layoutModel: String
  public var bindingModel: String
  public var shaderInterfaceModel: String
  public var vertexBufferPolicyModel: String
  public var externalBufferCeiling: Int
  public var immediateDataLayoutModel: String
  public var storageBufferSizeModel: String
  public var semanticFingerprint: String
  public var projectionSemanticFingerprint: String
  public var runtimeFingerprint: String
  public var generatedRuntimeFingerprint: String
  public var librarySHA256: String
  public var generatedLibrarySHA256: String

  public init(
    semanticSchemaVersion: Int,
    metalProjectionABI: Int,
    generatedSwiftABI: Int,
    bindingLayoutABI: Int,
    requiredVGPUABIVersion: Int,
    bindingSlotsABI: Int,
    layoutModel: String,
    bindingModel: String,
    shaderInterfaceModel: String,
    vertexBufferPolicyModel: String,
    externalBufferCeiling: Int,
    immediateDataLayoutModel: String,
    storageBufferSizeModel: String,
    semanticFingerprint: String,
    projectionSemanticFingerprint: String,
    runtimeFingerprint: String,
    generatedRuntimeFingerprint: String,
    librarySHA256: String,
    generatedLibrarySHA256: String
  ) {
    self.semanticSchemaVersion = semanticSchemaVersion
    self.metalProjectionABI = metalProjectionABI
    self.generatedSwiftABI = generatedSwiftABI
    self.bindingLayoutABI = bindingLayoutABI
    self.requiredVGPUABIVersion = requiredVGPUABIVersion
    self.bindingSlotsABI = bindingSlotsABI
    self.layoutModel = layoutModel
    self.bindingModel = bindingModel
    self.shaderInterfaceModel = shaderInterfaceModel
    self.vertexBufferPolicyModel = vertexBufferPolicyModel
    self.externalBufferCeiling = externalBufferCeiling
    self.immediateDataLayoutModel = immediateDataLayoutModel
    self.storageBufferSizeModel = storageBufferSizeModel
    self.semanticFingerprint = semanticFingerprint
    self.projectionSemanticFingerprint = projectionSemanticFingerprint
    self.runtimeFingerprint = runtimeFingerprint
    self.generatedRuntimeFingerprint = generatedRuntimeFingerprint
    self.librarySHA256 = librarySHA256
    self.generatedLibrarySHA256 = generatedLibrarySHA256
  }
}

public struct AppShadersCompatibilityError: Error, Equatable, CustomStringConvertible, Sendable {
  public let code: String
  public let message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }

  public var description: String {
    "\(code): \(message)"
  }
}

public enum AppShadersShaderStage: String, Equatable, Sendable {
  case vertex
  case fragment
  case compute
}

public struct AppShadersStorageBufferSizeRegion: Equatable, Sendable {
  public let stage: AppShadersShaderStage
  public let immediateDataByteOffset: UInt32

  public init(stage: AppShadersShaderStage, immediateDataByteOffset: UInt32) {
    self.stage = stage
    self.immediateDataByteOffset = immediateDataByteOffset
  }
}

public struct AppShadersInternalBufferSlot: Equatable, Sendable {
  public let role: String
  public let stage: AppShadersShaderStage
  public let index: Int
  public let count: Int

  public init(role: String, stage: AppShadersShaderStage, index: Int, count: Int) {
    self.role = role
    self.stage = stage
    self.index = index
    self.count = count
  }
}

public struct AppShadersMetalVertexAttribute: Equatable, Sendable {
  public let semanticLocation: Int
  public let metalAttribute: Int

  public init(semanticLocation: Int, metalAttribute: Int) {
    self.semanticLocation = semanticLocation
    self.metalAttribute = metalAttribute
  }
}

public struct AppShadersMetalColorOutput: Equatable, Sendable {
  public let semanticLocation: Int
  public let blendSource: Int?
  public let metalColor: Int
  public let metalIndex: Int?

  public init(
    semanticLocation: Int,
    blendSource: Int?,
    metalColor: Int,
    metalIndex: Int?
  ) {
    self.semanticLocation = semanticLocation
    self.blendSource = blendSource
    self.metalColor = metalColor
    self.metalIndex = metalIndex
  }
}

public enum AppShadersMetalEntryInterface: Equatable, Sendable {
  case vertex(attributes: [AppShadersMetalVertexAttribute])
  case fragment(colorOutputs: [AppShadersMetalColorOutput])
  case compute
}

public struct AppShadersEntryPointDescriptor: Equatable, Sendable {
  public let stage: AppShadersShaderStage
  public let metalName: String
  public let interface: AppShadersMetalEntryInterface

  fileprivate init(
    stage: AppShadersShaderStage,
    metalName: String,
    interface: AppShadersMetalEntryInterface
  ) {
    self.stage = stage
    self.metalName = metalName
    self.interface = interface
  }
}

public struct AppShadersProgramDescriptor: Equatable, Sendable {
  public let semanticProgram: String
  public let entryPoints: [AppShadersEntryPointDescriptor]
  public let storageBufferSizeRegions: [AppShadersStorageBufferSizeRegion]
  public let internalBufferSlots: [AppShadersInternalBufferSlot]

  fileprivate init(
    semanticProgram: String,
    entryPoints: [AppShadersEntryPointDescriptor],
    storageBufferSizeRegions: [AppShadersStorageBufferSizeRegion],
    internalBufferSlots: [AppShadersInternalBufferSlot]
  ) {
    self.semanticProgram = semanticProgram
    self.entryPoints = entryPoints
    self.storageBufferSizeRegions = storageBufferSizeRegions
    self.internalBufferSlots = internalBufferSlots
  }

  public func storageBufferSizeRegion(
    for stage: AppShadersShaderStage
  ) -> AppShadersStorageBufferSizeRegion? {
    storageBufferSizeRegions.first { $0.stage == stage }
  }

  public func metalEntryPoint(for stage: AppShadersShaderStage) -> String? {
    entryPoints.first { $0.stage == stage }?.metalName
  }
}

public struct AppShadersPipelineSelection: Equatable, Sendable {
  public let program: AppShadersProgramDescriptor
  public let stage: AppShadersShaderStage

  fileprivate init(
    program: AppShadersProgramDescriptor,
    stage: AppShadersShaderStage
  ) {
    self.program = program
    self.stage = stage
  }
}

public struct AppShadersComputeProjection: Sendable {
  public let metalEntryPoint: String
  public let bufferIndex: Int
  public let workgroupWidth: Int
  public let workgroupHeight: Int
  public let workgroupDepth: Int
  public let minimumBufferByteCount: Int
  public let elementCount: Int

  public init(
    metalEntryPoint: String,
    bufferIndex: Int,
    workgroupWidth: Int,
    workgroupHeight: Int,
    workgroupDepth: Int,
    minimumBufferByteCount: Int,
    elementCount: Int
  ) {
    self.metalEntryPoint = metalEntryPoint
    self.bufferIndex = bufferIndex
    self.workgroupWidth = workgroupWidth
    self.workgroupHeight = workgroupHeight
    self.workgroupDepth = workgroupDepth
    self.minimumBufferByteCount = minimumBufferByteCount
    self.elementCount = elementCount
  }
}

public enum AppShadersArtifact {
  public static let moduleName = "AppShaders"
  public static let swiftModuleName = "AppShaders"
  public static let minimumOSVersion = "14.0"
  public static let payloadKind = "__PAYLOAD_KIND__"
  public static let payloadFilename = "AppShaders.metallib"
  public static let invalidSentinelPrefix =
    "VGPU-C3-STRUCTURAL-SENTINEL-NOT-A-METALLIB"

  public static let noopProjection = AppShadersComputeProjection(
    metalEntryPoint: "__NOOP_METAL_ENTRY_POINT__",
    bufferIndex: __NOOP_BUFFER_INDEX__,
    workgroupWidth: __NOOP_WORKGROUP_WIDTH__,
    workgroupHeight: __NOOP_WORKGROUP_HEIGHT__,
    workgroupDepth: __NOOP_WORKGROUP_DEPTH__,
    minimumBufferByteCount: __NOOP_BUFFER_BYTE_COUNT__,
    elementCount: __NOOP_ELEMENT_COUNT__
  )

  public static let noopProgram = AppShadersProgramDescriptor(
    semanticProgram: "__NOOP_SEMANTIC_PROGRAM__",
    entryPoints: [
      AppShadersEntryPointDescriptor(
        stage: .compute,
        metalName: "__NOOP_METAL_ENTRY_POINT__",
        interface: .compute
      )
    ],
    storageBufferSizeRegions: [],
    internalBufferSlots: []
  )

  public static let runtimeArrayProgram = AppShadersProgramDescriptor(
    semanticProgram: "__RUNTIME_ARRAY_SEMANTIC_PROGRAM__",
    entryPoints: [
      AppShadersEntryPointDescriptor(
        stage: .compute,
        metalName: "__RUNTIME_ARRAY_METAL_ENTRY_POINT__",
        interface: .compute
      )
    ],
    storageBufferSizeRegions: [
      AppShadersStorageBufferSizeRegion(
        stage: .__RUNTIME_ARRAY_REGION_STAGE__,
        immediateDataByteOffset: __RUNTIME_ARRAY_REGION_OFFSET__
      )
    ],
    internalBufferSlots: [
      AppShadersInternalBufferSlot(
        role: "__RUNTIME_ARRAY_INTERNAL_ROLE__",
        stage: .__RUNTIME_ARRAY_INTERNAL_STAGE__,
        index: __RUNTIME_ARRAY_INTERNAL_INDEX__,
        count: __RUNTIME_ARRAY_INTERNAL_COUNT__
      )
    ]
  )

  public static let sparseDrawProgram = AppShadersProgramDescriptor(
    semanticProgram: "__SPARSE_DRAW_SEMANTIC_PROGRAM__",
    entryPoints: [
      AppShadersEntryPointDescriptor(
        stage: .vertex,
        metalName: "__SPARSE_VERTEX_METAL_ENTRY_POINT__",
        interface: .vertex(attributes: [
          AppShadersMetalVertexAttribute(
            semanticLocation: __SPARSE_VERTEX_LOCATION_0__,
            metalAttribute: __SPARSE_METAL_ATTRIBUTE_0__
          ),
          AppShadersMetalVertexAttribute(
            semanticLocation: __SPARSE_VERTEX_LOCATION_1__,
            metalAttribute: __SPARSE_METAL_ATTRIBUTE_1__
          ),
        ])
      ),
      AppShadersEntryPointDescriptor(
        stage: .fragment,
        metalName: "__SPARSE_FRAGMENT_METAL_ENTRY_POINT__",
        interface: .fragment(colorOutputs: [
          AppShadersMetalColorOutput(
            semanticLocation: __SPARSE_FRAGMENT_LOCATION_0__,
            blendSource: nil,
            metalColor: __SPARSE_METAL_COLOR_0__,
            metalIndex: nil
          ),
          AppShadersMetalColorOutput(
            semanticLocation: __SPARSE_FRAGMENT_LOCATION_1__,
            blendSource: nil,
            metalColor: __SPARSE_METAL_COLOR_1__,
            metalIndex: nil
          ),
        ])
      ),
    ],
    storageBufferSizeRegions: [],
    internalBufferSlots: [
      AppShadersInternalBufferSlot(
        role: "__SPARSE_INTERNAL_ROLE__",
        stage: .__SPARSE_INTERNAL_STAGE__,
        index: __SPARSE_INTERNAL_INDEX__,
        count: __SPARSE_INTERNAL_COUNT__
      )
    ]
  )

  public static let noopComputeSelection = AppShadersPipelineSelection(
    program: noopProgram,
    stage: .compute
  )

  public static let runtimeArrayComputeSelection = AppShadersPipelineSelection(
    program: runtimeArrayProgram,
    stage: .compute
  )

  public static let sparseDrawFragmentSelection = AppShadersPipelineSelection(
    program: sparseDrawProgram,
    stage: .fragment
  )

  public static let descriptor = AppShadersDescriptor(
    semanticSchemaVersion: 1,
    metalProjectionABI: 1,
    generatedSwiftABI: 1,
    bindingLayoutABI: 1,
    requiredVGPUABIVersion: 1,
    bindingSlotsABI: 1,
    layoutModel: "wgsl-host-shareable-v1",
    bindingModel: "vgpu-metal-binding-slots-v1",
    shaderInterfaceModel: "__SHADER_INTERFACE_MODEL__",
    vertexBufferPolicyModel: "__VERTEX_BUFFER_POLICY_MODEL__",
    externalBufferCeiling: __EXTERNAL_BUFFER_CEILING__,
    immediateDataLayoutModel: "__IMMEDIATE_DATA_LAYOUT_MODEL__",
    storageBufferSizeModel: "__STORAGE_BUFFER_SIZE_MODEL__",
    semanticFingerprint: "__SEMANTIC_SHA256__",
    projectionSemanticFingerprint: "__SEMANTIC_SHA256__",
    runtimeFingerprint: "__RUNTIME_SHA256__",
    generatedRuntimeFingerprint: "__RUNTIME_SHA256__",
    librarySHA256: "__LIBRARY_SHA256__",
    generatedLibrarySHA256: "__LIBRARY_SHA256__"
  )

  public static func payloadURL() throws -> URL {
    let matches =
      Bundle.module.urls(
        forResourcesWithExtension: "metallib",
        subdirectory: nil
      ) ?? []

    guard matches.count == 1, let url = matches.first else {
      throw AppShadersCompatibilityError(
        code: "packaged-resource-count",
        message: "Expected exactly one packaged .metallib resource, found \(matches.count)."
      )
    }

    guard url.lastPathComponent == payloadFilename else {
      throw AppShadersCompatibilityError(
        code: "packaged-resource-name",
        message: "Expected \(payloadFilename), found \(url.lastPathComponent)."
      )
    }

    return url
  }

  @discardableResult
  public static func verifyPackagedPayload() throws -> String {
    let data = try Data(contentsOf: payloadURL(), options: [.mappedIfSafe])
    let hash = sha256(data)

    guard hash == descriptor.librarySHA256 else {
      throw AppShadersCompatibilityError(
        code: "packaged-resource-hash",
        message: "Packaged payload SHA-256 does not match generated metadata."
      )
    }

    if payloadKind == "invalid-structural-sentinel" {
      guard data.starts(with: Data(invalidSentinelPrefix.utf8)) else {
        throw AppShadersCompatibilityError(
          code: "structural-sentinel-marker",
          message: "C3a payload is not the declared invalid structural sentinel."
        )
      }
    }

    return hash
  }

  public static func validateApplicationCompatibility(
    descriptor candidate: AppShadersDescriptor = descriptor,
    selection: AppShadersPipelineSelection,
    runtime: AppShadersRuntimeSupport = .fixtureSupported,
    payloadSHA256: String? = nil,
    createPipeline: (AppShadersPipelineSelection) throws -> Void
  ) throws {
    try require(
      runtime.semanticSchemaVersions.contains(candidate.semanticSchemaVersion),
      code: "unsupported-semantic-schema",
      field: "semantic schema",
      value: candidate.semanticSchemaVersion
    )
    try require(
      runtime.metalProjectionABIs.contains(candidate.metalProjectionABI),
      code: "unsupported-metal-projection-abi",
      field: "Metal projection ABI",
      value: candidate.metalProjectionABI
    )
    try require(
      runtime.generatedSwiftABIs.contains(candidate.generatedSwiftABI),
      code: "unsupported-generated-swift-abi",
      field: "generated Swift ABI",
      value: candidate.generatedSwiftABI
    )
    try require(
      runtime.bindingLayoutABIs.contains(candidate.bindingLayoutABI),
      code: "unsupported-binding-layout-abi",
      field: "binding layout ABI",
      value: candidate.bindingLayoutABI
    )

    let abi = VGPUABICompatibility(supportedVersions: runtime.vgpuABIVersions)
    try require(
      abi.supports(requiredVersion: candidate.requiredVGPUABIVersion),
      code: "unsupported-vgpu-abi",
      field: "VGPUABI",
      value: candidate.requiredVGPUABIVersion
    )
    try require(
      runtime.bindingSlotsABIs.contains(candidate.bindingSlotsABI),
      code: "unsupported-binding-slots-abi",
      field: "binding slots ABI",
      value: candidate.bindingSlotsABI
    )
    try require(
      runtime.layoutModels.contains(candidate.layoutModel),
      code: "unsupported-layout-model",
      field: "layout model",
      value: candidate.layoutModel
    )
    try require(
      runtime.bindingModels.contains(candidate.bindingModel),
      code: "unsupported-binding-model",
      field: "binding model",
      value: candidate.bindingModel
    )
    try require(
      runtime.shaderInterfaceModels.contains(candidate.shaderInterfaceModel),
      code: "unsupported-shader-interface-model",
      field: "shader-interface model",
      value: candidate.shaderInterfaceModel
    )
    try require(
      runtime.vertexBufferPolicyModels.contains(candidate.vertexBufferPolicyModel),
      code: "unsupported-vertex-buffer-policy-model",
      field: "vertex-buffer policy model",
      value: candidate.vertexBufferPolicyModel
    )
    if selection.program.internalBufferSlots.contains(where: {
      $0.role == "immediate-data" && $0.stage == selection.stage
    }) {
      try require(
        runtime.immediateDataLayoutModels.contains(candidate.immediateDataLayoutModel),
        code: "unsupported-immediate-data-layout-model",
        field: "immediate-data layout model",
        value: candidate.immediateDataLayoutModel
      )
    }
    if selection.program.storageBufferSizeRegion(for: selection.stage) != nil {
      try require(
        runtime.storageBufferSizeModels.contains(candidate.storageBufferSizeModel),
        code: "unsupported-storage-buffer-size-model",
        field: "storage-buffer-size model",
        value: candidate.storageBufferSizeModel
      )
    }
    try require(
      candidate.semanticFingerprint == candidate.projectionSemanticFingerprint,
      code: "semantic-fingerprint-mismatch",
      field: "semantic fingerprint",
      value: candidate.projectionSemanticFingerprint
    )
    try require(
      candidate.runtimeFingerprint == candidate.generatedRuntimeFingerprint,
      code: "runtime-projection-fingerprint-mismatch",
      field: "runtime projection fingerprint",
      value: candidate.generatedRuntimeFingerprint
    )
    try require(
      candidate.librarySHA256 == candidate.generatedLibrarySHA256,
      code: "library-hash-mismatch",
      field: "library SHA-256",
      value: candidate.generatedLibrarySHA256
    )

    let observedPayloadSHA256 = try payloadSHA256 ?? verifyPackagedPayload()
    try require(
      observedPayloadSHA256 == candidate.librarySHA256,
      code: "packaged-resource-hash",
      field: "packaged payload SHA-256",
      value: observedPayloadSHA256
    )

    try createPipeline(selection)
  }

  private static func require<T>(
    _ condition: @autoclosure () -> Bool,
    code: String,
    field: String,
    value: T
  ) throws {
    guard condition() else {
      throw AppShadersCompatibilityError(
        code: code,
        message: "Unsupported or inconsistent \(field): \(value)."
      )
    }
  }

  private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
