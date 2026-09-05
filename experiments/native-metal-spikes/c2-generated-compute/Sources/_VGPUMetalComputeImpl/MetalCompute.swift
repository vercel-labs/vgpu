import CryptoKit
import Dispatch
import Foundation
import Metal
import VGPUABI
import _VGPUBackendSPI
import _VGPUMetalCoreImpl
import _VGPUMetalResourcesImpl

package protocol MetalCompletionObserver: Sendable {
  func afterGPUCompletion() async
}

package enum MetalComputeBackendError: Error, CustomStringConvertible, Sendable {
  case invalidManifest(String)
  case invalidProgram
  case invalidBindings
  case invalidDispatch
  case commandResources
  case execution(String)

  package var description: String {
    switch self {
    case .invalidManifest(let message): "Invalid manifest: \(message)"
    case .invalidProgram: "The logical program does not match the physical artifact."
    case .invalidBindings: "The compute bindings do not match the physical artifact."
    case .invalidDispatch: "The physical dispatch dimensions are invalid."
    case .commandResources: "Metal could not create command resources."
    case .execution(let message): "Metal execution failed: \(message)"
    }
  }
}

private struct MetalBinding: Decodable {
  struct Descriptor: Decodable {
    let kind: String
    let addressSpace: String
    let access: String
    let minimumBindingSize: Int
    let runtimeSized: Bool
  }

  struct Location: Decodable {
    let stage: String
    let mode: String
    let resourceClass: String
    let component: String
    let index: Int
    let count: Int
  }

  let semanticBinding: String
  let descriptor: Descriptor
  let slots: [Location]
}

private struct MetalInternalBinding: Decodable {
  let role: String
  let slots: [MetalBinding.Location]
}

private struct MetalEntryPoint: Decodable {
  let stage: String
  let metal: String
}

private struct MetalSizeRegion: Decodable {
  let stage: String
  let immediateDataByteOffset: Int
}

private struct MetalWorkgroupSize: Decodable {
  let x: Int
  let y: Int
  let z: Int
}

private struct MetalSamplingPair: Decodable {}

private struct RuntimeTailManifest: Decodable {
  let schemaVersion: Int
  let immediateDataLayoutModel: String
  let storageBufferSizeModel: String
  let semanticProgram: String
  let kind: String
  let entryPoints: [MetalEntryPoint]
  let bindings: [MetalBinding]
  let samplingPairs: [MetalSamplingPair]
  let internalBindings: [MetalInternalBinding]
  let storageBufferSizeRegions: [MetalSizeRegion]
  let resolvedWorkgroupSize: MetalWorkgroupSize

  init(data: Data) throws {
    self = try JSONDecoder().decode(Self.self, from: data)
    try validate()
  }

  var entryPoint: MetalEntryPoint { entryPoints[0] }
  var immediate: MetalBinding.Location { internalBindings[0].slots[0] }
  var sizeRegion: MetalSizeRegion { storageBufferSizeRegions[0] }

  fileprivate func validate() throws {
    guard schemaVersion == 1 else { throw MetalComputeBackendError.invalidManifest("schema") }
    guard immediateDataLayoutModel == "vgpu-metal-immediate-data-layout-v1" else {
      throw MetalComputeBackendError.invalidManifest("immediate-data model")
    }
    guard storageBufferSizeModel == "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1"
    else {
      throw MetalComputeBackendError.invalidManifest("storage-size model")
    }
    guard
      semanticProgram == "AssemblyRuntimeSizedStorage",
      kind == "compute",
      entryPoints.count == 1,
      entryPoint.stage == "compute",
      entryPoint.metal == "vgpu_assembly_runtime_sized_storage_compute"
    else {
      throw MetalComputeBackendError.invalidManifest("entry point")
    }
    guard
      bindings.count == 2,
      samplingPairs.isEmpty,
      bindings.map(\.semanticBinding) == ["g0b0", "g0b1"],
      bindings.allSatisfy({ $0.slots.count == 1 }),
      bindings[0].descriptor.runtimeSized,
      !bindings[1].descriptor.runtimeSized,
      bindings[0].descriptor.access == "read",
      bindings[1].descriptor.access == "read_write",
      bindings[0].descriptor.minimumBindingSize == 16,
      bindings[1].descriptor.minimumBindingSize == 8
    else {
      throw MetalComputeBackendError.invalidManifest("external bindings")
    }
    for binding in bindings {
      let location = binding.slots[0]
      guard
        binding.descriptor.kind == "buffer",
        binding.descriptor.addressSpace == "storage",
        location.stage == "compute",
        location.mode == "direct",
        location.resourceClass == "buffer",
        location.component == "buffer",
        location.count == 1,
        (0..<31).contains(location.index)
      else {
        throw MetalComputeBackendError.invalidManifest("external location")
      }
    }
    guard
      internalBindings.count == 1,
      internalBindings[0].role == "immediate-data",
      internalBindings[0].slots.count == 1,
      immediate.stage == "compute",
      immediate.mode == "direct",
      immediate.resourceClass == "buffer",
      immediate.component == "buffer",
      immediate.index == 30,
      immediate.count == 1,
      storageBufferSizeRegions.count == 1,
      sizeRegion.stage == "compute",
      sizeRegion.immediateDataByteOffset == 4,
      resolvedWorkgroupSize.x == 1,
      resolvedWorkgroupSize.y == 1,
      resolvedWorkgroupSize.z == 1,
      Set([bindings[0].slots[0].index, bindings[1].slots[0].index, immediate.index]).count
        == 3
    else {
      throw MetalComputeBackendError.invalidManifest("internal bindings")
    }
  }
}

private struct ConnectedArtifact: Decodable {
  struct ABI: Decodable {
    let semanticSchemaVersion: Int
    let metalProjectionABI: Int
    let generatedSwiftABI: Int
    let bindingLayoutABI: Int
    let requiredVGPUABIVersion: Int
  }

  struct Fingerprint: Decodable {
    let sha256: String
  }

  struct Library: Decodable {
    let sha256: String
  }

  struct Evidence: Decodable {
    let requestSha256: String
    let responseSha256: String
    let mslSha256: String
    let metallibSha256: String
  }

  let schemaVersion: Int
  let contractId: String
  let artifactID: String
  let abi: ABI
  let semantic: Fingerprint
  let projection: Fingerprint
  let library: Library
  let runtimeManifest: RuntimeTailManifest
  let evidence: Evidence

  init(
    data: Data,
    descriptor: _VGPUProgramDescriptor,
    artifact: _VGPUProgramArtifact
  ) throws {
    guard sha256(data) == artifact.descriptorSHA256 else {
      throw MetalComputeBackendError.invalidManifest("descriptor hash")
    }
    try validateConnectedArtifactJSONShape(data)
    self = try JSONDecoder().decode(Self.self, from: data)
    guard
      schemaVersion == 1,
      contractId == "vgpu-native-connected-artifact-spike/v1",
      artifactID == descriptor.artifactID,
      abi.semanticSchemaVersion == 1,
      abi.metalProjectionABI == 1,
      abi.generatedSwiftABI == 1,
      abi.bindingLayoutABI == 1,
      abi.requiredVGPUABIVersion == 1
    else {
      throw MetalComputeBackendError.invalidManifest("connected artifact ABI")
    }
    for digest in [
      semantic.sha256,
      projection.sha256,
      library.sha256,
      evidence.requestSha256,
      evidence.responseSha256,
      evidence.mslSha256,
      evidence.metallibSha256,
      artifact.descriptorSHA256,
      artifact.librarySHA256,
    ] where !isLowercaseSHA256(digest) {
      throw MetalComputeBackendError.invalidManifest("digest")
    }
    guard
      library.sha256 == evidence.metallibSha256,
      library.sha256 == artifact.librarySHA256
    else {
      throw MetalComputeBackendError.invalidManifest("library hash")
    }
    try runtimeManifest.validate()
    guard
      runtimeManifest.semanticProgram == "AssemblyRuntimeSizedStorage",
      descriptor.entryPointID == "compute_main",
      runtimeManifest.entryPoint.stage == "compute"
    else {
      throw MetalComputeBackendError.invalidProgram
    }
  }

  func validateLibrary(_ data: Data, artifact: _VGPUProgramArtifact) throws {
    guard sha256(data) == artifact.librarySHA256 else {
      throw MetalComputeBackendError.invalidManifest("library hash")
    }
  }
}

private func validateConnectedArtifactJSONShape(_ data: Data) throws {
  let value: Any
  do {
    value = try JSONSerialization.jsonObject(with: data)
  } catch {
    throw MetalComputeBackendError.invalidManifest("descriptor JSON")
  }
  let root = try exactObject(
    value,
    keys: [
      "schemaVersion",
      "contractId",
      "artifactID",
      "abi",
      "semantic",
      "projection",
      "library",
      "runtimeManifest",
      "evidence",
    ]
  )
  _ = try exactObject(
    root["abi"],
    keys: [
      "semanticSchemaVersion",
      "metalProjectionABI",
      "generatedSwiftABI",
      "bindingLayoutABI",
      "requiredVGPUABIVersion",
    ]
  )
  for key in ["semantic", "projection", "library"] {
    _ = try exactObject(root[key], keys: ["sha256"])
  }
  _ = try exactObject(
    root["evidence"],
    keys: ["requestSha256", "responseSha256", "mslSha256", "metallibSha256"]
  )

  let manifest = try exactObject(
    root["runtimeManifest"],
    keys: [
      "schemaVersion",
      "immediateDataLayoutModel",
      "storageBufferSizeModel",
      "semanticProgram",
      "kind",
      "entryPoints",
      "bindings",
      "samplingPairs",
      "internalBindings",
      "storageBufferSizeRegions",
      "resolvedWorkgroupSize",
    ]
  )
  for entry in try exactArray(manifest["entryPoints"]) {
    _ = try exactObject(entry, keys: ["stage", "metal"])
  }
  for bindingValue in try exactArray(manifest["bindings"]) {
    let binding = try exactObject(
      bindingValue,
      keys: ["semanticBinding", "descriptor", "slots"]
    )
    _ = try exactObject(
      binding["descriptor"],
      keys: ["kind", "addressSpace", "access", "minimumBindingSize", "runtimeSized"]
    )
    try validateSlotShapes(binding["slots"])
  }
  _ = try exactArray(manifest["samplingPairs"])
  for internalValue in try exactArray(manifest["internalBindings"]) {
    let internalBinding = try exactObject(internalValue, keys: ["role", "slots"])
    try validateSlotShapes(internalBinding["slots"])
  }
  for region in try exactArray(manifest["storageBufferSizeRegions"]) {
    _ = try exactObject(region, keys: ["stage", "immediateDataByteOffset"])
  }
  _ = try exactObject(manifest["resolvedWorkgroupSize"], keys: ["x", "y", "z"])
}

private func validateSlotShapes(_ value: Any?) throws {
  for slot in try exactArray(value) {
    _ = try exactObject(
      slot,
      keys: ["stage", "mode", "resourceClass", "component", "index", "count"]
    )
  }
}

private func exactObject(_ value: Any?, keys: Set<String>) throws -> [String: Any] {
  guard let object = value as? [String: Any], Set(object.keys) == keys else {
    throw MetalComputeBackendError.invalidManifest("descriptor shape")
  }
  return object
}

private func exactArray(_ value: Any?) throws -> [Any] {
  guard let array = value as? [Any] else {
    throw MetalComputeBackendError.invalidManifest("descriptor shape")
  }
  return array
}

private func sha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func isLowercaseSHA256(_ value: String) -> Bool {
  value.utf8.count == 64
    && value.utf8.allSatisfy {
      (48...57).contains($0) || (97...102).contains($0)
    }
}

private struct PreparedMetalProgram {
  let descriptor: _VGPUProgramDescriptor
  let pipeline: MTLComputePipelineState
  let manifest: RuntimeTailManifest
  let reflection: [String]
}

private final class MetalExecution: VGPUBackendExecution, @unchecked Sendable {
  private let commandBuffer: MTLCommandBuffer
  private let observer: any MetalCompletionObserver

  init(commandBuffer: MTLCommandBuffer, observer: any MetalCompletionObserver) {
    self.commandBuffer = commandBuffer
    self.observer = observer
  }

  func wait() async throws {
    await commandBuffer.completed()
    let error =
      commandBuffer.status == .completed && commandBuffer.error == nil
      ? nil
      : MetalComputeBackendError.execution(
        commandBuffer.error?.localizedDescription ?? "unknown error"
      )
    await observer.afterGPUCompletion()
    if let error { throw error }
  }
}

package final class MetalComputeBackend: VGPUComputeBackend, @unchecked Sendable {
  package let core: MetalCore
  private let resources: MetalResourceBackend
  private let fallbackMetallibData: Data?
  private let fallbackManifestData: Data?
  private let observer: any MetalCompletionObserver
  private let queue: MTLCommandQueue
  private let lock = NSLock()
  private var nextHandle: UInt64 = 1
  private var programs: [VGPUBackendProgramHandle: PreparedMetalProgram] = [:]
  private var submittedInputs: [(identity: UInt64, generation: UInt64, range: Int)] = []
  private var submittedImmediateWords: [[UInt32]] = []

  package init(
    core: MetalCore,
    resources: MetalResourceBackend,
    metallibData: Data? = nil,
    manifestData: Data? = nil,
    observer: any MetalCompletionObserver
  ) throws {
    self.core = core
    self.resources = resources
    self.fallbackMetallibData = metallibData
    self.fallbackManifestData = manifestData
    self.observer = observer
    self.queue = core.commandQueue
  }

  package var contextIdentity: UInt64 { core.contextIdentity }

  package func prepareCompute(
    _ descriptor: _VGPUProgramDescriptor
  ) throws -> VGPUBackendProgramHandle {
    guard descriptor.artifactID == "assembly-runtime-sized-storage",
      descriptor.bindings == [
        _VGPULogicalBindingDescriptor(ordinal: 0, access: .read, runtimeSized: true),
        _VGPULogicalBindingDescriptor(ordinal: 1, access: .readWrite, runtimeSized: false),
      ],
      descriptor.workgroupSize.x == 1,
      descriptor.workgroupSize.y == 1,
      descriptor.workgroupSize.z == 1
    else {
      throw MetalComputeBackendError.invalidProgram
    }
    let manifest: RuntimeTailManifest
    let metallibData: Data
    if let artifact = descriptor.artifact {
      let descriptorData = try artifact.descriptorData()
      let connected = try ConnectedArtifact(
        data: descriptorData,
        descriptor: descriptor,
        artifact: artifact
      )
      metallibData = try artifact.libraryData()
      try connected.validateLibrary(metallibData, artifact: artifact)
      manifest = connected.runtimeManifest
    } else {
      guard
        descriptor.entryPointID == "inspect-values",
        let fallbackMetallibData,
        let fallbackManifestData
      else {
        throw MetalComputeBackendError.invalidProgram
      }
      metallibData = fallbackMetallibData
      manifest = try RuntimeTailManifest(data: fallbackManifestData)
    }
    let libraryData = metallibData.withUnsafeBytes { DispatchData(bytes: $0) }
    let library = try core.device.makeLibrary(data: libraryData)
    guard let function = library.makeFunction(name: manifest.entryPoint.metal) else {
      throw MetalComputeBackendError.invalidProgram
    }
    var pipelineReflection: MTLComputePipelineReflection?
    let pipeline = try core.device.makeComputePipelineState(
      function: function,
      options: .bindingInfo,
      reflection: &pipelineReflection
    )
    guard let pipelineReflection else { throw MetalComputeBackendError.invalidProgram }
    let expectedAccessByBufferIndex: [Int: MTLBindingAccess] = [
      manifest.bindings[0].slots[0].index: .readOnly,
      manifest.bindings[1].slots[0].index: .readWrite,
      manifest.immediate.index: .readOnly,
    ]
    let reflection = try pipelineReflection.bindings
      .filter(\.isUsed)
      .map { binding -> String in
        guard
          binding.type == .buffer,
          let buffer = binding as? MTLBufferBinding,
          expectedAccessByBufferIndex[buffer.index] == binding.access
        else {
          throw MetalComputeBackendError.invalidProgram
        }
        return "buffer/\(buffer.index)/\(buffer.bufferDataSize)/\(buffer.bufferAlignment)"
      }
      .sorted()
    let runtimeSizedSlot = manifest.bindings
      .filter(\.descriptor.runtimeSized)
      .flatMap(\.slots)
      .filter { $0.resourceClass == "buffer" }
      .map(\.index)
      .max()
    guard let runtimeSizedSlot else {
      throw MetalComputeBackendError.invalidManifest("storage-size slots")
    }
    let (sizeTableWords, slotOverflow) = runtimeSizedSlot.addingReportingOverflow(1)
    let (sizeTableBytes, tableOverflow) = sizeTableWords.multipliedReportingOverflow(by: 4)
    let (immediateDataSize, immediateOverflow) = manifest.sizeRegion.immediateDataByteOffset
      .addingReportingOverflow(sizeTableBytes)
    guard !slotOverflow, !tableOverflow, !immediateOverflow else {
      throw MetalComputeBackendError.invalidManifest("storage-size span")
    }
    let expectedReflection = [
      "buffer/\(manifest.bindings[0].slots[0].index)/\(manifest.bindings[0].descriptor.minimumBindingSize)/4",
      "buffer/\(manifest.bindings[1].slots[0].index)/\(manifest.bindings[1].descriptor.minimumBindingSize)/4",
      "buffer/\(manifest.immediate.index)/\(immediateDataSize)/4",
    ].sorted()
    guard reflection == expectedReflection else {
      throw MetalComputeBackendError.invalidProgram
    }

    lock.lock()
    let handle = VGPUBackendProgramHandle(rawValue: nextHandle)
    nextHandle += 1
    programs[handle] = PreparedMetalProgram(
      descriptor: descriptor,
      pipeline: pipeline,
      manifest: manifest,
      reflection: reflection
    )
    lock.unlock()
    return handle
  }

  package func submitCompute(
    _ command: VGPUBackendComputeCommand
  ) throws -> any VGPUBackendExecution {
    lock.lock()
    let program = programs[command.programHandle]
    lock.unlock()
    guard let program, program.descriptor == command.program else {
      throw MetalComputeBackendError.invalidProgram
    }
    guard
      command.bindings.count == 2,
      command.bindings.map(\.ordinal) == [0, 1],
      command.bindings[0].elementCount != nil,
      command.bindings[1].elementCount == nil,
      command.bindings[1].boundByteCount >= 8,
      command.threadgroups.x > 0,
      command.threadgroups.y > 0,
      command.threadgroups.z > 0
    else {
      throw MetalComputeBackendError.invalidBindings
    }
    let input = command.bindings[0]
    let output = command.bindings[1]
    guard
      input.boundByteCount >= program.manifest.bindings[0].descriptor.minimumBindingSize,
      input.boundByteCount <= Int(UInt32.max),
      input.boundByteCount % 4 == 0
    else {
      throw MetalComputeBackendError.invalidBindings
    }
    let inputBuffer = try resources.buffer(for: input.snapshot)
    let outputBuffer = try resources.buffer(for: output.snapshot)
    guard
      inputBuffer.device === core.device,
      outputBuffer.device === core.device,
      input.snapshot.offset + input.boundByteCount <= inputBuffer.length,
      output.snapshot.offset + output.boundByteCount <= outputBuffer.length
    else {
      throw MetalComputeBackendError.invalidBindings
    }
    guard
      let commandBuffer = queue.makeCommandBuffer(),
      let encoder = commandBuffer.makeComputeCommandEncoder()
    else {
      throw MetalComputeBackendError.commandResources
    }
    encoder.setComputePipelineState(program.pipeline)
    encoder.setBuffer(
      inputBuffer,
      offset: input.snapshot.offset,
      index: program.manifest.bindings[0].slots[0].index
    )
    encoder.setBuffer(
      outputBuffer,
      offset: output.snapshot.offset,
      index: program.manifest.bindings[1].slots[0].index
    )
    let wordOffset = program.manifest.sizeRegion.immediateDataByteOffset / 4
    let inputIndex = program.manifest.bindings[0].slots[0].index
    var words = [UInt32](repeating: 0, count: wordOffset + inputIndex + 1)
    words[wordOffset + inputIndex] = UInt32(input.boundByteCount).littleEndian
    words.withUnsafeBytes { bytes in
      encoder.setBytes(
        bytes.baseAddress!,
        length: bytes.count,
        index: program.manifest.immediate.index
      )
    }
    encoder.dispatchThreadgroups(
      MTLSize(
        width: command.threadgroups.x,
        height: command.threadgroups.y,
        depth: command.threadgroups.z
      ),
      threadsPerThreadgroup: MTLSize(
        width: program.manifest.resolvedWorkgroupSize.x,
        height: program.manifest.resolvedWorkgroupSize.y,
        depth: program.manifest.resolvedWorkgroupSize.z
      )
    )
    encoder.endEncoding()
    lock.lock()
    submittedInputs.append(
      (
        identity: input.snapshot.allocationIdentity,
        generation: input.snapshot.generation,
        range: input.boundByteCount
      )
    )
    submittedImmediateWords.append(words.map { UInt32(littleEndian: $0) })
    lock.unlock()
    commandBuffer.commit()
    return MetalExecution(commandBuffer: commandBuffer, observer: observer)
  }

  package var reflection: [String] {
    lock.lock()
    defer { lock.unlock() }
    return programs.keys.sorted { $0.rawValue < $1.rawValue }.first.flatMap {
      programs[$0]?.reflection
    } ?? []
  }

  package var inputSnapshots: [(identity: UInt64, generation: UInt64, range: Int)] {
    lock.lock()
    defer { lock.unlock() }
    return submittedInputs
  }

  package var immediateUploads: [[UInt32]] {
    lock.lock()
    defer { lock.unlock() }
    return submittedImmediateWords
  }
}

private struct ImmediateCompletionObserver: MetalCompletionObserver {
  func afterGPUCompletion() async {}
}

extension MetalBackend {
  package var computeBackend: MetalComputeBackend {
    get throws {
      try capabilityState(MetalComputeBackend.self) {
        try MetalComputeBackend(
          core: core,
          resources: resourceBackend,
          observer: ImmediateCompletionObserver()
        )
      }
    }
  }
}

extension MetalBackend: VGPUComputeBackend {
  package func prepareCompute(
    _ program: _VGPUProgramDescriptor
  ) throws -> VGPUBackendProgramHandle {
    try computeBackend.prepareCompute(program)
  }

  package func submitCompute(
    _ command: VGPUBackendComputeCommand
  ) throws -> any VGPUBackendExecution {
    try computeBackend.submitCompute(command)
  }
}
