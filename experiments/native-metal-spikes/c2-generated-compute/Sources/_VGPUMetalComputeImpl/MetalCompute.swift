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

private struct RuntimeTailManifest: Decodable {
  let schemaVersion: Int
  let immediateDataLayoutModel: String
  let storageBufferSizeModel: String
  let semanticProgram: String
  let kind: String
  let entryPoints: [MetalEntryPoint]
  let bindings: [MetalBinding]
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

  private func validate() throws {
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
      immediate.index == 30,
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
  private let metallibData: Data
  private let manifestData: Data
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
    metallibData: Data,
    manifestData: Data,
    observer: any MetalCompletionObserver
  ) throws {
    guard let queue = core.device.makeCommandQueue() else {
      throw MetalComputeBackendError.commandResources
    }
    self.core = core
    self.resources = resources
    self.metallibData = metallibData
    self.manifestData = manifestData
    self.observer = observer
    self.queue = queue
  }

  package var contextIdentity: UInt64 { core.contextIdentity }

  package func prepareCompute(
    _ descriptor: _VGPUProgramDescriptor
  ) throws -> VGPUBackendProgramHandle {
    guard
      descriptor.artifactID == "assembly-runtime-sized-storage",
      descriptor.entryPointID == "inspect-values",
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
    let manifest = try RuntimeTailManifest(data: manifestData)
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
    let reflection = try pipelineReflection.bindings
      .filter { $0.type == .buffer && $0.isUsed }
      .map { binding -> String in
        guard let buffer = binding as? MTLBufferBinding else {
          throw MetalComputeBackendError.invalidProgram
        }
        return "buffer/\(buffer.index)/\(buffer.bufferDataSize)/\(buffer.bufferAlignment)"
      }
      .sorted()

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
