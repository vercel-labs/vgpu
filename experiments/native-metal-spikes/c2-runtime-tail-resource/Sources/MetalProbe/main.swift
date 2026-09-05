import Darwin
import Foundation
import GeneratedFixture
import Metal
import VGPUABI
import VGPUResources
import _VGPUBackendSPI

struct MetalProbeError: Error, CustomStringConvertible {
  let description: String
}

func fail(_ message: String) throws -> Never {
  throw MetalProbeError(description: message)
}

func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() {
    try fail(message)
  }
}

struct EmptyArrayElement: Decodable {
  init(from decoder: any Decoder) throws {
    try fail("samplingPairs must be empty for the fixed compute fixture")
  }
}

struct MetalSlot: Decodable {
  let stage: String
  let mode: String
  let resourceClass: String
  let component: String
  let index: Int
  let count: Int

  func validate(owner: String) throws {
    try require(stage == "compute", "\(owner) must select compute")
    try require(mode == "direct", "\(owner) must use direct binding")
    try require(resourceClass == "buffer", "\(owner) must select a buffer")
    try require(component == "buffer", "\(owner) must select its buffer component")
    try require(count == 1, "\(owner) must bind exactly one buffer")
    try require((0..<31).contains(index), "\(owner) exceeds the Metal buffer-slot profile")
  }
}

struct BufferDescriptor: Decodable {
  let kind: String
  let addressSpace: String
  let access: String
  let minimumBindingSize: Int
  let runtimeSized: Bool
}

struct BufferBinding: Decodable {
  let semanticBinding: String
  let descriptor: BufferDescriptor
  let slots: [MetalSlot]

  var slot: MetalSlot { slots[0] }
}

struct InternalBinding: Decodable {
  let role: String
  let slots: [MetalSlot]

  var slot: MetalSlot { slots[0] }
}

struct ProjectedEntryPoint: Decodable {
  let stage: String
  let metal: String
}

struct StorageBufferSizeRegion: Decodable {
  let stage: String
  let immediateDataByteOffset: Int
}

struct WorkgroupSize: Decodable {
  let x: Int
  let y: Int
  let z: Int

  var metalSize: MTLSize {
    MTLSize(width: x, height: y, depth: z)
  }
}

struct RuntimeSizedStorageManifest: Decodable {
  let schemaVersion: Int
  let immediateDataLayoutModel: String
  let storageBufferSizeModel: String
  let semanticProgram: String
  let kind: String
  let entryPoints: [ProjectedEntryPoint]
  let bindings: [BufferBinding]
  let samplingPairs: [EmptyArrayElement]
  let internalBindings: [InternalBinding]
  let storageBufferSizeRegions: [StorageBufferSizeRegion]
  let resolvedWorkgroupSize: WorkgroupSize

  static func load(path: String) throws -> RuntimeSizedStorageManifest {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let manifest = try JSONDecoder().decode(Self.self, from: data)
    try manifest.validateFixedFixture()
    return manifest
  }

  var input: BufferBinding { bindings[0] }
  var output: BufferBinding { bindings[1] }
  var immediate: InternalBinding { internalBindings[0] }
  var sizeRegion: StorageBufferSizeRegion { storageBufferSizeRegions[0] }
  var entry: ProjectedEntryPoint { entryPoints[0] }

  func validateFixedFixture() throws {
    try require(schemaVersion == 1, "manifest schemaVersion must be one")
    try require(
      immediateDataLayoutModel == "vgpu-metal-immediate-data-layout-v1",
      "manifest has an unsupported immediate-data layout model"
    )
    try require(
      storageBufferSizeModel == "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
      "manifest has an unsupported storage-buffer-size model"
    )
    try require(
      semanticProgram == "AssemblyRuntimeSizedStorage",
      "manifest differs from the fixed semantic program"
    )
    try require(kind == "compute", "manifest must describe a compute program")
    try require(samplingPairs.isEmpty, "compute manifest must not contain sampling pairs")
    try require(entryPoints.count == 1, "manifest must contain one compute entry point")
    try require(
      entry.stage == "compute"
        && entry.metal == "vgpu_assembly_runtime_sized_storage_compute",
      "manifest differs from the fixed compute entry point"
    )
    try require(
      bindings.count == 2 && bindings.map(\.semanticBinding) == ["g0b0", "g0b1"],
      "manifest differs from the fixed external bindings"
    )
    for (index, binding) in bindings.enumerated() {
      try require(binding.slots.count == 1, "bindings[\(index)] must have one slot")
      try binding.slot.validate(owner: "bindings[\(index)].slots[0]")
      try require(
        binding.descriptor.kind == "buffer" && binding.descriptor.addressSpace == "storage",
        "bindings[\(index)] must describe storage"
      )
    }
    try require(
      input.slot.index == 0 && input.descriptor.access == "read"
        && input.descriptor.minimumBindingSize == 16 && input.descriptor.runtimeSized,
      "manifest differs from the fixed runtime-sized input"
    )
    try require(
      output.slot.index == 1 && output.descriptor.access == "read_write"
        && output.descriptor.minimumBindingSize == 8 && !output.descriptor.runtimeSized,
      "manifest differs from the fixed output"
    )
    try require(internalBindings.count == 1, "manifest must have one internal binding")
    try require(immediate.slots.count == 1, "immediate-data binding must have one slot")
    try immediate.slot.validate(owner: "internalBindings[0].slots[0]")
    try require(
      immediate.role == "immediate-data" && immediate.slot.index == 30,
      "manifest differs from the fixed immediate-data binding"
    )
    try require(
      storageBufferSizeRegions.count == 1 && sizeRegion.stage == "compute"
        && sizeRegion.immediateDataByteOffset == 4,
      "manifest differs from the fixed storage-size region"
    )
    try require(
      sizeRegion.immediateDataByteOffset % 4 == 0,
      "storage-size region must be word-aligned"
    )
    try require(
      resolvedWorkgroupSize.x == 1 && resolvedWorkgroupSize.y == 1
        && resolvedWorkgroupSize.z == 1,
      "manifest differs from the fixed workgroup size"
    )
    try require(
      Set([input.slot.index, output.slot.index, immediate.slot.index]).count == 3,
      "manifest buffer slots collide"
    )
  }
}

enum MetalStorageBackendError: Error, CustomStringConvertible {
  case allocation
  case missingAllocation
  case invalidRange
  case byteCount

  var description: String {
    switch self {
    case .allocation: "Metal could not allocate shared storage"
    case .missingAllocation: "Metal storage allocation is missing"
    case .invalidRange: "Metal storage range is invalid"
    case .byteCount: "Metal replacement byte count differs from its range"
    }
  }
}

final class MetalStorageBackend: VGPUStorageBackend, @unchecked Sendable {
  private struct Allocation {
    let buffer: MTLBuffer
    let access: VGPUStorageAccess
    let identity: UInt64
    let generation: UInt64
    let offset: Int
  }

  let device: MTLDevice
  private let lock = NSLock()
  private var nextHandle: UInt64 = 1
  private var allocations: [VGPUBackendStorageHandle: Allocation] = [:]

  init(device: MTLDevice) {
    self.device = device
  }

  func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess
  ) throws -> VGPUBackendStorageHandle {
    try withLock {
      guard !initialBytes.isEmpty else {
        throw MetalStorageBackendError.allocation
      }
      let buffer = initialBytes.withUnsafeBytes { bytes -> MTLBuffer? in
        guard let baseAddress = bytes.baseAddress else { return nil }
        return device.makeBuffer(
          bytes: baseAddress,
          length: bytes.count,
          options: [.storageModeShared]
        )
      }
      guard let buffer else {
        throw MetalStorageBackendError.allocation
      }
      let handle = VGPUBackendStorageHandle(rawValue: nextHandle)
      nextHandle += 1
      buffer.label = "typed-runtime-storage-\(handle.rawValue)"
      allocations[handle] = Allocation(
        buffer: buffer,
        access: access,
        identity: handle.rawValue,
        generation: 1,
        offset: 0
      )
      return handle
    }
  }

  func replaceStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>,
    bytes: Data
  ) throws {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw MetalStorageBackendError.missingAllocation
      }
      guard range.lowerBound >= 0, range.upperBound <= allocation.buffer.length else {
        throw MetalStorageBackendError.invalidRange
      }
      guard range.count == bytes.count else {
        throw MetalStorageBackendError.byteCount
      }
      bytes.withUnsafeBytes { source in
        guard let sourceAddress = source.baseAddress else { return }
        memcpy(
          allocation.buffer.contents().advanced(by: range.lowerBound),
          sourceAddress,
          source.count
        )
      }
    }
  }

  func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw MetalStorageBackendError.missingAllocation
      }
      guard range.lowerBound >= 0, range.upperBound <= allocation.buffer.length else {
        throw MetalStorageBackendError.invalidRange
      }
      return Data(
        bytes: allocation.buffer.contents().advanced(by: range.lowerBound),
        count: range.count
      )
    }
  }

  func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw MetalStorageBackendError.missingAllocation
      }
      return VGPUBackendStorageSnapshot(
        handle: handle,
        identity: allocation.identity,
        generation: allocation.generation,
        offset: allocation.offset,
        backingByteCount: allocation.buffer.length,
        access: allocation.access
      )
    }
  }

  func disposeStorage(handle: VGPUBackendStorageHandle) {
    _ = withLock {
      allocations.removeValue(forKey: handle)
    }
  }

  func buffer(for handle: VGPUBackendStorageHandle) throws -> MTLBuffer {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw MetalStorageBackendError.missingAllocation
      }
      return allocation.buffer
    }
  }

  func contains(_ handle: VGPUBackendStorageHandle) -> Bool {
    withLock { allocations[handle] != nil }
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

struct ReflectedBuffer {
  let index: Int
  let dataSize: Int
  let alignment: Int

  var report: String {
    "buffer/\(index)/\(dataSize)/\(alignment)"
  }
}

func makePipeline(
  device: MTLDevice,
  libraryPath: String,
  entryPoint: String
) throws -> (pipeline: MTLComputePipelineState, reflection: [ReflectedBuffer]) {
  let library = try device.makeLibrary(URL: URL(fileURLWithPath: libraryPath))
  guard let function = library.makeFunction(name: entryPoint) else {
    try fail("metallib omitted \(entryPoint)")
  }
  var pipelineReflection: MTLComputePipelineReflection?
  let pipeline = try device.makeComputePipelineState(
    function: function,
    options: .bindingInfo,
    reflection: &pipelineReflection
  )
  guard let pipelineReflection else {
    try fail("Metal returned no compute binding reflection")
  }
  let reflected = try pipelineReflection.bindings
    .filter { $0.type == .buffer && $0.isUsed }
    .map { binding -> ReflectedBuffer in
      guard let buffer = binding as? MTLBufferBinding else {
        try fail("Metal reported a non-buffer binding as a buffer")
      }
      return ReflectedBuffer(
        index: Int(buffer.index),
        dataSize: Int(buffer.bufferDataSize),
        alignment: Int(buffer.bufferAlignment)
      )
    }
    .sorted { $0.index < $1.index }
  try require(
    reflected.map(\.report) == [
      "buffer/0/16/4",
      "buffer/1/8/4",
      "buffer/30/8/4",
    ],
    "Metal binding reflection differs from the fixed fixture: \(reflected.map(\.report))"
  )
  return (pipeline, reflected)
}

struct PreparedRuntimeView {
  let snapshot: VGPUPreparedRuntimeStorageBinding
  let immediateWords: [UInt32]
}

func prepare(
  _ binding: Values.Binding,
  manifest: RuntimeSizedStorageManifest
) throws -> PreparedRuntimeView {
  let snapshot = try binding._backendSnapshot(requiredAccess: .read)
  let range = snapshot.boundByteCount
  try require(range >= manifest.input.descriptor.minimumBindingSize, "range is below minimum")
  try require(range <= Int(UInt32.max), "range exceeds UInt32")
  try require(range % 4 == 0, "range is not word-aligned")
  try require(snapshot.allocation.offset >= 0, "allocation offset is negative")
  try require(
    snapshot.allocation.offset % 4 == 0,
    "allocation offset is not storage-aligned"
  )
  try require(
    range <= snapshot.allocation.backingByteCount - snapshot.allocation.offset,
    "range exceeds its allocation"
  )

  let runtimeBindings = manifest.bindings.filter(\.descriptor.runtimeSized)
  guard let highestSlot = runtimeBindings.map({ $0.slot.index }).max() else {
    try fail("size region has no runtime-sized storage binding")
  }
  let regionWordOffset = manifest.sizeRegion.immediateDataByteOffset / 4
  try require(
    regionWordOffset + highestSlot + 1 <= 32,
    "immediate-data payload exceeds the fixed profile"
  )
  var words = [UInt32](repeating: 0, count: regionWordOffset + highestSlot + 1)
  words[regionWordOffset + manifest.input.slot.index] = UInt32(range)
  return PreparedRuntimeView(snapshot: snapshot, immediateWords: words)
}

func makeOutputBuffer(device: MTLDevice, label: String) throws -> MTLBuffer {
  guard let buffer = device.makeBuffer(length: 8, options: [.storageModeShared]) else {
    try fail("Metal could not allocate \(label)")
  }
  buffer.label = label
  memset(buffer.contents(), 0, buffer.length)
  return buffer
}

func encode(
  _ prepared: PreparedRuntimeView,
  output: MTLBuffer,
  backend: MetalStorageBackend,
  manifest: RuntimeSizedStorageManifest,
  pipeline: MTLComputePipelineState,
  encoder: MTLComputeCommandEncoder
) throws {
  let input = try backend.buffer(for: prepared.snapshot.allocation.handle)
  try require(input.device === pipeline.device, "typed storage belongs to another device")
  try require(output.device === pipeline.device, "output belongs to another device")
  encoder.setComputePipelineState(pipeline)
  encoder.setBuffer(
    input,
    offset: prepared.snapshot.allocation.offset,
    index: manifest.input.slot.index
  )
  encoder.setBuffer(output, offset: 0, index: manifest.output.slot.index)
  let words = prepared.immediateWords.map(\.littleEndian)
  words.withUnsafeBytes { bytes in
    encoder.setBytes(
      bytes.baseAddress!,
      length: bytes.count,
      index: manifest.immediate.slot.index
    )
  }
  encoder.dispatchThreadgroups(
    MTLSize(width: 1, height: 1, depth: 1),
    threadsPerThreadgroup: manifest.resolvedWorkgroupSize.metalSize
  )
}

func readWords(_ buffer: MTLBuffer, count: Int) -> [UInt32] {
  let words = buffer.contents().bindMemory(to: UInt32.self, capacity: count)
  return (0..<count).map { UInt32(littleEndian: words[$0]) }
}

func wordsHex(_ words: [UInt32]) -> String {
  words
    .flatMap { word -> [UInt8] in
      var littleEndian = word.littleEndian
      return withUnsafeBytes(of: &littleEndian) { Array($0) }
    }
    .map { String(format: "%02x", $0) }
    .joined()
}

func emit(_ report: [String: Any]) throws {
  let data = try JSONSerialization.data(
    withJSONObject: report,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let json = String(data: data, encoding: .utf8) else {
    try fail("could not encode Metal report")
  }
  print(json)
}

func runMetalProbe() async throws {
  guard CommandLine.arguments.count == 3 else {
    try fail("usage: MetalProbe <library.metallib> <manifest.json>")
  }
  let manifest = try RuntimeSizedStorageManifest.load(path: CommandLine.arguments[2])
  guard let device = MTLCreateSystemDefaultDevice() else {
    try fail("No default Metal device is available")
  }
  let pipelineResult = try makePipeline(
    device: device,
    libraryPath: CommandLine.arguments[1],
    entryPoint: manifest.entry.metal
  )
  let backend = MetalStorageBackend(device: device)
  let gpu = VGPU(backend: backend)
  let initial = [
    Particle(mass: 10, id: 101),
    Particle(mass: 20, id: 202),
    Particle(mass: 30, id: 303),
    Particle(mass: 40, id: 404),
  ]
  let values: Values.Storage = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 77),
    capacity: 4,
    access: .read,
    initialElements: initial
  )
  let short: Values.Binding = try values.binding(elementCount: 2)
  let long: Values.Binding = try values.binding(elementCount: 4)
  let shortPrepared = try prepare(short, manifest: manifest)
  let longPrepared = try prepare(long, manifest: manifest)
  try require(
    shortPrepared.snapshot.allocation.identity == longPrepared.snapshot.allocation.identity
      && shortPrepared.snapshot.allocation.generation
        == longPrepared.snapshot.allocation.generation
      && shortPrepared.snapshot.allocation.offset == longPrepared.snapshot.allocation.offset,
    "typed views do not retain one allocation identity, generation, and offset"
  )
  try require(
    shortPrepared.immediateWords == [0, 28] && longPrepared.immediateWords == [0, 52],
    "typed view ranges did not produce the expected immediate-data words"
  )

  let typedPrefix = try await values.readPrefix()
  let typedElements = try await values.readElements(range: 0..<4)
  try require(typedPrefix == .init(prefix: 77), "Metal-backed typed prefix readback drifted")
  try require(typedElements == initial, "Metal-backed typed element readback drifted")

  let shortOutput = try makeOutputBuffer(device: device, label: "runtime-short-output")
  let longOutput = try makeOutputBuffer(device: device, label: "runtime-long-output")
  guard
    let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer(),
    let encoder = commandBuffer.makeComputeCommandEncoder()
  else {
    try fail("Metal could not create compute command resources")
  }
  try encode(
    shortPrepared,
    output: shortOutput,
    backend: backend,
    manifest: manifest,
    pipeline: pipelineResult.pipeline,
    encoder: encoder
  )
  try encode(
    longPrepared,
    output: longOutput,
    backend: backend,
    manifest: manifest,
    pipeline: pipelineResult.pipeline,
    encoder: encoder
  )
  encoder.endEncoding()
  commandBuffer.commit()
  await commandBuffer.completed()
  try require(
    commandBuffer.status == .completed && commandBuffer.error == nil,
    "Metal dispatch failed: \(commandBuffer.error?.localizedDescription ?? "unknown error")"
  )
  let readbacks = [readWords(shortOutput, count: 2), readWords(longOutput, count: 2)]
  try require(
    readbacks == [[2, 202], [4, 404]],
    "Metal runtime-tail readback drifted: \(readbacks)"
  )

  try values.dispose()
  try require(
    !backend.contains(shortPrepared.snapshot.allocation.handle),
    "typed Metal resource did not dispose"
  )
  try emit([
    "device": device.name,
    "disposed": true,
    "effectiveRanges": [short.sizeInBytes, long.sizeInBytes],
    "immediateUploads": [
      wordsHex(shortPrepared.immediateWords),
      wordsHex(longPrepared.immediateWords),
    ],
    "readbacks": readbacks,
    "reflection": pipelineResult.reflection.map(\.report),
    "sameBacking": true,
    "gate": "c2-runtime-tail-resource-metal",
    "schemaVersion": 1,
    "status": "passed",
    "typedReadback": [
      "elementIDs": typedElements.map(\.id),
      "prefix": typedPrefix.prefix,
    ],
  ])
}

@main
enum MetalProbe {
  static func main() async {
    do {
      try await runMetalProbe()
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      Darwin.exit(1)
    }
  }
}
