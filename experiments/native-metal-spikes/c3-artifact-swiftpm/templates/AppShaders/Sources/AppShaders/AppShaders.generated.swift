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
  public var vertexBufferPolicyModels: Set<String>

  public init(
    semanticSchemaVersions: ClosedRange<Int>,
    metalProjectionABIs: ClosedRange<Int>,
    generatedSwiftABIs: ClosedRange<Int>,
    bindingLayoutABIs: ClosedRange<Int>,
    vgpuABIVersions: ClosedRange<Int>,
    bindingSlotsABIs: ClosedRange<Int>,
    layoutModels: Set<String>,
    bindingModels: Set<String>,
    vertexBufferPolicyModels: Set<String>
  ) {
    self.semanticSchemaVersions = semanticSchemaVersions
    self.metalProjectionABIs = metalProjectionABIs
    self.generatedSwiftABIs = generatedSwiftABIs
    self.bindingLayoutABIs = bindingLayoutABIs
    self.vgpuABIVersions = vgpuABIVersions
    self.bindingSlotsABIs = bindingSlotsABIs
    self.layoutModels = layoutModels
    self.bindingModels = bindingModels
    self.vertexBufferPolicyModels = vertexBufferPolicyModels
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
    vertexBufferPolicyModels: ["vgpu-metal-pipeline-local-vertex-buffer-slots-v1"]
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
  public var vertexBufferPolicyModel: String
  public var externalBufferCeiling: Int
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
    vertexBufferPolicyModel: String,
    externalBufferCeiling: Int,
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
    self.vertexBufferPolicyModel = vertexBufferPolicyModel
    self.externalBufferCeiling = externalBufferCeiling
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

  public static let descriptor = AppShadersDescriptor(
    semanticSchemaVersion: 1,
    metalProjectionABI: 1,
    generatedSwiftABI: 1,
    bindingLayoutABI: 1,
    requiredVGPUABIVersion: 1,
    bindingSlotsABI: 1,
    layoutModel: "wgsl-host-shareable-v1",
    bindingModel: "vgpu-metal-binding-slots-v1",
    vertexBufferPolicyModel: "__VERTEX_BUFFER_POLICY_MODEL__",
    externalBufferCeiling: __EXTERNAL_BUFFER_CEILING__,
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
    runtime: AppShadersRuntimeSupport = .fixtureSupported,
    payloadSHA256: String? = nil,
    createPipeline: () throws -> Void
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
      runtime.vertexBufferPolicyModels.contains(candidate.vertexBufferPolicyModel),
      code: "unsupported-vertex-buffer-policy-model",
      field: "vertex-buffer policy model",
      value: candidate.vertexBufferPolicyModel
    )
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

    try createPipeline()
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
