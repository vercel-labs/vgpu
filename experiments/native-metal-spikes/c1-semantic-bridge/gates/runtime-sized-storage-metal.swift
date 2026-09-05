import CoreFoundation
import Foundation
import Metal

struct RuntimeSizedStorageProbeError: Error, CustomStringConvertible {
  let description: String
}

func fail(_ message: String) throws -> Never {
  throw RuntimeSizedStorageProbeError(description: message)
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() {
    try fail(message)
  }
}

func exactObject(_ value: Any, keys: Set<String>, owner: String) throws -> [String: Any] {
  guard let object = value as? [String: Any] else {
    try fail("\(owner) must be an object")
  }
  try require(Set(object.keys) == keys, "\(owner) has unexpected or missing properties")
  return object
}

func arrayValue(_ value: Any?, owner: String) throws -> [Any] {
  guard let array = value as? [Any] else {
    try fail("\(owner) must be an array")
  }
  return array
}

func stringValue(_ value: Any?, owner: String) throws -> String {
  guard let string = value as? String else {
    try fail("\(owner) must be a string")
  }
  return string
}

func integerValue(_ value: Any?, owner: String) throws -> Int {
  guard
    let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.rounded(.towardZero) == number.doubleValue,
    number.doubleValue >= 0,
    number.doubleValue <= Double(UInt32.max)
  else {
    try fail("\(owner) must be an exact UInt32 value")
  }
  let result = number.intValue
  try require(
    result >= 0 && Double(result) == number.doubleValue,
    "\(owner) must be an exact UInt32 value"
  )
  return result
}

func boolValue(_ value: Any?, owner: String) throws -> Bool {
  guard
    let number = value as? NSNumber,
    CFGetTypeID(number) == CFBooleanGetTypeID()
  else {
    try fail("\(owner) must be a boolean")
  }
  return number.boolValue
}

struct MetalBufferSlot {
  let index: Int

  static func decode(_ value: Any, owner: String) throws -> MetalBufferSlot {
    let object = try exactObject(
      value,
      keys: ["stage", "mode", "resourceClass", "component", "index", "count"],
      owner: owner
    )
    let stage = try stringValue(object["stage"], owner: "\(owner).stage")
    let mode = try stringValue(object["mode"], owner: "\(owner).mode")
    let resourceClass = try stringValue(
      object["resourceClass"], owner: "\(owner).resourceClass")
    let component = try stringValue(object["component"], owner: "\(owner).component")
    let count = try integerValue(object["count"], owner: "\(owner).count")
    try require(stage == "compute", "\(owner) must select compute")
    try require(mode == "direct", "\(owner) mode must be direct")
    try require(resourceClass == "buffer", "\(owner) resource class must be buffer")
    try require(component == "buffer", "\(owner) component must be buffer")
    try require(count == 1, "\(owner) count must be one")
    let index = try integerValue(object["index"], owner: "\(owner).index")
    try require(index < 31, "\(owner) exceeds the current Metal buffer-slot profile")
    return MetalBufferSlot(index: index)
  }
}

struct RuntimeBufferDescriptor {
  let addressSpace: String
  let access: String
  let minimumBindingSize: Int
  let runtimeSized: Bool

  static func decode(_ value: Any, owner: String) throws -> RuntimeBufferDescriptor {
    let object = try exactObject(
      value,
      keys: ["kind", "addressSpace", "access", "minimumBindingSize", "runtimeSized"],
      owner: owner
    )
    let kind = try stringValue(object["kind"], owner: "\(owner).kind")
    try require(kind == "buffer", "\(owner) kind must be buffer")
    let addressSpace = try stringValue(
      object["addressSpace"], owner: "\(owner).addressSpace")
    let access = try stringValue(object["access"], owner: "\(owner).access")
    try require(addressSpace == "storage", "\(owner) must describe storage")
    try require(["read", "read_write"].contains(access), "\(owner) has unsupported access")
    let minimumBindingSize = try integerValue(
      object["minimumBindingSize"], owner: "\(owner).minimumBindingSize")
    try require(minimumBindingSize > 0, "\(owner) minimum must be positive")
    return RuntimeBufferDescriptor(
      addressSpace: addressSpace,
      access: access,
      minimumBindingSize: minimumBindingSize,
      runtimeSized: try boolValue(object["runtimeSized"], owner: "\(owner).runtimeSized")
    )
  }
}

struct RuntimeBufferBindingLayout {
  let semanticBinding: String
  let descriptor: RuntimeBufferDescriptor
  let slot: MetalBufferSlot

  static func decode(_ value: Any, owner: String) throws -> RuntimeBufferBindingLayout {
    let object = try exactObject(
      value,
      keys: ["semanticBinding", "descriptor", "slots"],
      owner: owner
    )
    let semanticBinding = try stringValue(
      object["semanticBinding"], owner: "\(owner).semanticBinding")
    try require(
      semanticBinding.range(
        of: #"^g(?:0|[1-9][0-9]*)b(?:0|[1-9][0-9]*)$"#,
        options: .regularExpression
      ) != nil,
      "\(owner) has an invalid semantic binding"
    )
    let slots = try arrayValue(object["slots"], owner: "\(owner).slots")
    try require(slots.count == 1, "\(owner) must have one compute buffer slot")
    return RuntimeBufferBindingLayout(
      semanticBinding: semanticBinding,
      descriptor: try RuntimeBufferDescriptor.decode(
        object["descriptor"] as Any, owner: "\(owner).descriptor"),
      slot: try MetalBufferSlot.decode(slots[0], owner: "\(owner).slots[0]")
    )
  }
}

struct InternalBufferBinding {
  let role: String
  let slot: MetalBufferSlot

  static func decode(_ value: Any, owner: String) throws -> InternalBufferBinding {
    let object = try exactObject(value, keys: ["role", "slots"], owner: owner)
    let slots = try arrayValue(object["slots"], owner: "\(owner).slots")
    try require(slots.count == 1, "\(owner) must have one compute buffer slot")
    return InternalBufferBinding(
      role: try stringValue(object["role"], owner: "\(owner).role"),
      slot: try MetalBufferSlot.decode(slots[0], owner: "\(owner).slots[0]")
    )
  }
}

struct StorageBufferSizeRegion {
  let immediateDataByteOffset: Int

  static func decode(_ value: Any, owner: String) throws -> StorageBufferSizeRegion {
    let object = try exactObject(
      value, keys: ["stage", "immediateDataByteOffset"], owner: owner)
    let stage = try stringValue(object["stage"], owner: "\(owner).stage")
    try require(stage == "compute", "\(owner) must select compute")
    let offset = try integerValue(
      object["immediateDataByteOffset"], owner: "\(owner).immediateDataByteOffset")
    try require(offset % 4 == 0, "\(owner) offset must be word-aligned")
    return StorageBufferSizeRegion(immediateDataByteOffset: offset)
  }
}

struct ProjectedComputeEntry {
  let metal: String

  static func decode(_ value: Any, owner: String) throws -> ProjectedComputeEntry {
    let object = try exactObject(value, keys: ["stage", "metal"], owner: owner)
    let stage = try stringValue(object["stage"], owner: "\(owner).stage")
    try require(stage == "compute", "\(owner) must select compute")
    let metal = try stringValue(object["metal"], owner: "\(owner).metal")
    try require(
      metal.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil,
      "\(owner) has an invalid Metal entry name"
    )
    return ProjectedComputeEntry(metal: metal)
  }
}

struct WorkgroupSize {
  let x: Int
  let y: Int
  let z: Int

  static func decode(_ value: Any, owner: String) throws -> WorkgroupSize {
    let object = try exactObject(value, keys: ["x", "y", "z"], owner: owner)
    let result = WorkgroupSize(
      x: try integerValue(object["x"], owner: "\(owner).x"),
      y: try integerValue(object["y"], owner: "\(owner).y"),
      z: try integerValue(object["z"], owner: "\(owner).z")
    )
    try require(
      result.x > 0 && result.y > 0 && result.z > 0,
      "\(owner) dimensions must be positive"
    )
    return result
  }

  var metalSize: MTLSize {
    MTLSize(width: x, height: y, depth: z)
  }
}

struct RuntimeSizedStorageManifest {
  let immediateDataLayoutModel: String
  let storageBufferSizeModel: String
  let semanticProgram: String
  let entry: ProjectedComputeEntry
  let bindings: [RuntimeBufferBindingLayout]
  let internalBindings: [InternalBufferBinding]
  let storageBufferSizeRegions: [StorageBufferSizeRegion]
  let resolvedWorkgroupSize: WorkgroupSize

  static func decode(contentsOf url: URL) throws -> RuntimeSizedStorageManifest {
    let data = try Data(contentsOf: url)
    let rootValue = try JSONSerialization.jsonObject(with: data)
    let root = try exactObject(
      rootValue,
      keys: [
        "schemaVersion", "immediateDataLayoutModel", "storageBufferSizeModel",
        "semanticProgram", "kind", "entryPoints", "bindings", "samplingPairs",
        "internalBindings", "storageBufferSizeRegions", "resolvedWorkgroupSize",
      ],
      owner: "runtime-sized storage manifest"
    )
    let schemaVersion = try integerValue(root["schemaVersion"], owner: "schemaVersion")
    let kind = try stringValue(root["kind"], owner: "kind")
    try require(
      schemaVersion == 1,
      "runtime-sized storage manifest schemaVersion must be one"
    )
    try require(kind == "compute", "runtime-sized storage manifest kind must be compute")
    let samplingPairs = try arrayValue(root["samplingPairs"], owner: "samplingPairs")
    try require(samplingPairs.isEmpty, "compute manifest must not contain sampling pairs")
    let entries = try arrayValue(root["entryPoints"], owner: "entryPoints")
    try require(entries.count == 1, "runtime-sized storage manifest needs one compute entry")
    let bindings = try arrayValue(root["bindings"], owner: "bindings").enumerated().map {
      index, value in
      try RuntimeBufferBindingLayout.decode(value, owner: "bindings[\(index)]")
    }
    let internalBindings = try arrayValue(
      root["internalBindings"], owner: "internalBindings"
    ).enumerated().map {
      index, value in
      try InternalBufferBinding.decode(value, owner: "internalBindings[\(index)]")
    }
    let regions = try arrayValue(
      root["storageBufferSizeRegions"], owner: "storageBufferSizeRegions"
    ).enumerated().map { index, value in
      try StorageBufferSizeRegion.decode(
        value, owner: "storageBufferSizeRegions[\(index)]")
    }
    let result = RuntimeSizedStorageManifest(
      immediateDataLayoutModel: try stringValue(
        root["immediateDataLayoutModel"], owner: "immediateDataLayoutModel"),
      storageBufferSizeModel: try stringValue(
        root["storageBufferSizeModel"], owner: "storageBufferSizeModel"),
      semanticProgram: try stringValue(root["semanticProgram"], owner: "semanticProgram"),
      entry: try ProjectedComputeEntry.decode(entries[0], owner: "entryPoints[0]"),
      bindings: bindings,
      internalBindings: internalBindings,
      storageBufferSizeRegions: regions,
      resolvedWorkgroupSize: try WorkgroupSize.decode(
        root["resolvedWorkgroupSize"] as Any, owner: "resolvedWorkgroupSize")
    )
    try result.validateShape()
    return result
  }

  var immediateDataSlot: MetalBufferSlot? {
    internalBindings.first { $0.role == "immediate-data" }?.slot
  }

  var storageBufferSizeRegion: StorageBufferSizeRegion? {
    storageBufferSizeRegions.first
  }

  func validateShape() throws {
    try require(!semanticProgram.isEmpty, "semanticProgram must not be empty")
    try require(!bindings.isEmpty, "runtime-sized storage manifest has no bindings")
    try require(
      Set(bindings.map(\.semanticBinding)).count == bindings.count,
      "runtime-sized storage manifest repeats a semantic binding"
    )
    try require(
      Set(internalBindings.map(\.role)).count == internalBindings.count,
      "runtime-sized storage manifest repeats an internal role"
    )
    try require(
      internalBindings.allSatisfy { $0.role == "immediate-data" },
      "runtime-sized storage manifest has an unsupported internal role"
    )
    try require(
      storageBufferSizeRegions.count <= 1,
      "runtime-sized storage manifest repeats the compute size region"
    )

    var occupied: Set<Int> = []
    for binding in bindings {
      try require(
        occupied.insert(binding.slot.index).inserted,
        "external Metal buffer slots collide"
      )
    }
    for internalBinding in internalBindings {
      try require(
        occupied.insert(internalBinding.slot.index).inserted,
        "internal and external Metal buffer slots collide"
      )
    }

    if let region = storageBufferSizeRegion {
      try require(
        immediateDataSlot != nil,
        "storage-buffer-size region requires one immediate-data slot"
      )
      try require(
        bindings.contains { $0.descriptor.runtimeSized },
        "storage-buffer-size region has no runtime-sized storage binding"
      )
      try require(
        region.immediateDataByteOffset == 4,
        "compute immediate-data layout v1 requires its size region at byte 4"
      )
    }
  }

  func validateRuntimeSupport() throws {
    if immediateDataSlot != nil {
      try require(
        immediateDataLayoutModel == "vgpu-metal-immediate-data-layout-v1",
        "unsupported immediate-data layout model \(immediateDataLayoutModel)"
      )
    }
    if storageBufferSizeRegion != nil {
      try require(
        storageBufferSizeModel
          == "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
        "unsupported storage-buffer-size model \(storageBufferSizeModel)"
      )
    }
  }
}

func assertExpectedManifest(_ manifest: RuntimeSizedStorageManifest) throws {
  try require(
    manifest.semanticProgram == "AssemblyRuntimeSizedStorage",
    "runtime-sized storage manifest differs from the fixed fixture"
  )
  try require(
    manifest.entry.metal == "vgpu_assembly_runtime_sized_storage_compute",
    "runtime-sized storage manifest differs from the fixed fixture"
  )
  try require(
    manifest.bindings.map(\.semanticBinding) == ["g0b0", "g0b1"],
    "runtime-sized storage manifest differs from the fixed fixture"
  )
  let input = manifest.bindings[0]
  let output = manifest.bindings[1]
  try require(
    input.slot.index == 0 && input.descriptor.access == "read"
      && input.descriptor.minimumBindingSize == 16 && input.descriptor.runtimeSized,
    "runtime-sized storage manifest differs from the fixed fixture"
  )
  try require(
    output.slot.index == 1 && output.descriptor.access == "read_write"
      && output.descriptor.minimumBindingSize == 8 && !output.descriptor.runtimeSized,
    "runtime-sized storage manifest differs from the fixed fixture"
  )
  try require(
    manifest.internalBindings.count == 1 && manifest.immediateDataSlot?.index == 30,
    "runtime-sized storage manifest differs from the fixed fixture"
  )
  try require(
    manifest.storageBufferSizeRegions.count == 1
      && manifest.storageBufferSizeRegion?.immediateDataByteOffset == 4,
    "runtime-sized storage manifest differs from the fixed fixture"
  )
  let workgroup = manifest.resolvedWorkgroupSize
  try require(
    workgroup.x == 1 && workgroup.y == 1 && workgroup.z == 1,
    "runtime-sized storage manifest differs from the fixed fixture"
  )
}

final class MetalRuntimeContext {
  let device: MTLDevice

  init(device: MTLDevice) {
    self.device = device
  }
}

struct BufferUsage: OptionSet {
  let rawValue: Int

  static let storageRead = BufferUsage(rawValue: 1 << 0)
  static let storageWrite = BufferUsage(rawValue: 1 << 1)
}

final class RawBufferAllocation {
  let identity: String
  let context: MetalRuntimeContext
  let buffer: MTLBuffer
  let logicalLength: Int
  let usage: BufferUsage

  init(
    identity: String,
    context: MetalRuntimeContext,
    buffer: MTLBuffer,
    logicalLength: Int,
    usage: BufferUsage
  ) throws {
    try require(buffer.device === context.device, "\(identity) belongs to another Metal device")
    try require(
      logicalLength > 0 && logicalLength <= buffer.length,
      "\(identity) logical buffer length is invalid"
    )
    self.identity = identity
    self.context = context
    self.buffer = buffer
    self.logicalLength = logicalLength
    self.usage = usage
  }
}

struct BoundBufferRange {
  let allocation: RawBufferAllocation
  let offset: Int
  let rangeBytes: Int
}

struct PreparedBufferCommand {
  let semanticBinding: String
  let index: Int
  let range: BoundBufferRange
}

struct PreparedComputeBindings {
  fileprivate let owner: RawMetalComputeProgram
  let commands: [PreparedBufferCommand]
  let immediateDataSlot: Int?
  let immediateWords: [UInt32]
}

final class RawMetalComputeProgram {
  let context: MetalRuntimeContext
  let manifest: RuntimeSizedStorageManifest
  let pipeline: MTLComputePipelineState

  init(
    context: MetalRuntimeContext,
    manifest: RuntimeSizedStorageManifest,
    pipeline: MTLComputePipelineState
  ) throws {
    try manifest.validateShape()
    try manifest.validateRuntimeSupport()
    try require(
      pipeline.device === context.device,
      "runtime-sized storage pipeline belongs to another Metal device"
    )
    self.context = context
    self.manifest = manifest
    self.pipeline = pipeline
  }
}

struct RuntimeSizedMetalBinder {
  let program: RawMetalComputeProgram

  func prepare(resources: [String: BoundBufferRange]) throws -> PreparedComputeBindings {
    let manifest = program.manifest
    try manifest.validateShape()
    try manifest.validateRuntimeSupport()
    try require(
      Set(resources.keys) == Set(manifest.bindings.map(\.semanticBinding)),
      "runtime-sized storage resource set is incomplete or contains extras"
    )

    var commands: [PreparedBufferCommand] = []
    for binding in manifest.bindings {
      guard let range = resources[binding.semanticBinding] else {
        try fail("missing runtime resource \(binding.semanticBinding)")
      }
      try validate(range: range, descriptor: binding.descriptor, binding: binding.semanticBinding)
      commands.append(
        PreparedBufferCommand(
          semanticBinding: binding.semanticBinding,
          index: binding.slot.index,
          range: range
        ))
    }

    var immediateWords: [UInt32] = []
    if let immediateSlot = manifest.immediateDataSlot {
      if let region = manifest.storageBufferSizeRegion {
        let runtimeBindings = manifest.bindings.filter { $0.descriptor.runtimeSized }
        guard let highestSlot = runtimeBindings.map({ $0.slot.index }).max() else {
          try fail("storage-buffer-size region has no runtime-sized storage binding")
        }
        let regionWordOffset = region.immediateDataByteOffset / 4
        let wordCount = highestSlot + 1
        try require(
          regionWordOffset + wordCount <= 32,
          "runtime-sized storage immediate payload exceeds the current profile"
        )
        immediateWords = [UInt32](repeating: 0, count: regionWordOffset + wordCount)
        for binding in runtimeBindings {
          guard let range = resources[binding.semanticBinding] else {
            try fail("missing runtime resource \(binding.semanticBinding)")
          }
          immediateWords[regionWordOffset + binding.slot.index] = UInt32(range.rangeBytes)
        }
      } else {
        immediateWords = [0]
      }
      try require(!immediateWords.isEmpty, "immediate-data slot has no payload")
      return PreparedComputeBindings(
        owner: program,
        commands: commands,
        immediateDataSlot: immediateSlot.index,
        immediateWords: immediateWords
      )
    }
    try require(
      manifest.storageBufferSizeRegion == nil,
      "storage-buffer-size region has no immediate-data slot"
    )
    return PreparedComputeBindings(
      owner: program,
      commands: commands,
      immediateDataSlot: nil,
      immediateWords: []
    )
  }

  func encode(_ prepared: PreparedComputeBindings, into encoder: MTLComputeCommandEncoder) throws {
    try require(
      prepared.owner === program,
      "prepared bindings belong to another runtime-sized storage program"
    )
    try require(
      encoder.device === program.context.device,
      "compute encoder belongs to another Metal device"
    )
    encoder.setComputePipelineState(program.pipeline)
    for command in prepared.commands {
      encoder.setBuffer(
        command.range.allocation.buffer,
        offset: command.range.offset,
        index: command.index
      )
    }
    if let immediateDataSlot = prepared.immediateDataSlot {
      let words = prepared.immediateWords.map(\.littleEndian)
      words.withUnsafeBytes { bytes in
        encoder.setBytes(bytes.baseAddress!, length: bytes.count, index: immediateDataSlot)
      }
    }
  }

  private func validate(
    range: BoundBufferRange,
    descriptor: RuntimeBufferDescriptor,
    binding: String
  ) throws {
    let allocation = range.allocation
    try require(allocation.context === program.context, "\(binding) belongs to another context")
    try require(
      allocation.buffer.device === program.context.device,
      "\(binding) belongs to another Metal device"
    )
    try require(
      allocation.logicalLength > 0 && allocation.logicalLength <= allocation.buffer.length,
      "\(binding) logical buffer length is invalid"
    )
    try require(
      range.offset >= 0 && range.offset <= allocation.logicalLength,
      "\(binding) buffer offset is invalid"
    )
    try require(range.offset % 4 == 0, "\(binding) buffer offset is not word-aligned")
    try require(range.rangeBytes > 0, "\(binding) buffer range must be positive")
    try require(
      range.rangeBytes <= Int(UInt32.max),
      "\(binding) buffer range exceeds UInt32"
    )
    try require(
      range.rangeBytes >= descriptor.minimumBindingSize,
      "\(binding) buffer range is below its semantic minimum"
    )
    try require(
      range.rangeBytes <= allocation.logicalLength - range.offset,
      "\(binding) buffer range exceeds its logical allocation"
    )
    try require(
      range.rangeBytes % 4 == 0,
      "\(binding) storage range is not word-aligned"
    )
    try require(
      allocation.usage.contains(.storageRead),
      "\(binding) lacks storage-read usage"
    )
    if descriptor.access == "read_write" {
      try require(
        allocation.usage.contains(.storageWrite),
        "\(binding) lacks storage-write usage"
      )
    }
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

func reflectedBuffers(_ bindings: [MTLBinding]) -> [ReflectedBuffer] {
  bindings
    .filter { $0.type == .buffer && $0.isUsed }
    .map { binding in
      let buffer = binding as! MTLBufferBinding
      return ReflectedBuffer(
        index: Int(buffer.index),
        dataSize: Int(buffer.bufferDataSize),
        alignment: Int(buffer.bufferAlignment)
      )
    }
    .sorted { $0.index < $1.index }
}

func makePipeline(
  device: MTLDevice,
  libraryPath: String,
  entryPoint: String
) throws -> (MTLComputePipelineState, [ReflectedBuffer]) {
  let library = try device.makeLibrary(URL: URL(fileURLWithPath: libraryPath))
  guard let function = library.makeFunction(name: entryPoint) else {
    try fail("runtime-sized storage metallib omitted \(entryPoint)")
  }
  var reflection: MTLComputePipelineReflection?
  let pipeline = try device.makeComputePipelineState(
    function: function,
    options: .bindingInfo,
    reflection: &reflection
  )
  guard let reflection else {
    try fail("runtime-sized storage pipeline returned no binding reflection")
  }
  let buffers = reflectedBuffers(reflection.bindings)
  try require(
    buffers.map(\.index) == [0, 1, 30],
    "runtime-sized storage reflection buffer indices drifted"
  )
  try require(
    buffers.map(\.report) == [
      "buffer/0/16/4",
      "buffer/1/8/4",
      "buffer/30/8/4",
    ],
    "runtime-sized storage reflection sizes or alignments drifted"
  )
  guard let immediate = buffers.first(where: { $0.index == 30 }) else {
    try fail("runtime-sized storage reflection omitted immediate data")
  }
  try require(
    immediate.dataSize == 8 && immediate.alignment == 4,
    "runtime-sized storage immediate reflection drifted"
  )
  return (pipeline, buffers)
}

func makeBuffer(
  context: MetalRuntimeContext,
  identity: String,
  physicalLength: Int,
  logicalLength: Int,
  usage: BufferUsage
) throws -> RawBufferAllocation {
  guard
    let buffer = context.device.makeBuffer(
      length: physicalLength,
      options: [.storageModeShared]
    )
  else {
    try fail("could not allocate \(identity)")
  }
  buffer.label = identity
  memset(buffer.contents(), 0xcd, buffer.length)
  return try RawBufferAllocation(
    identity: identity,
    context: context,
    buffer: buffer,
    logicalLength: logicalLength,
    usage: usage
  )
}

func storeWord(_ value: UInt32, in allocation: RawBufferAllocation, at offset: Int) {
  allocation.buffer.contents().advanced(by: offset).storeBytes(
    of: value.littleEndian,
    as: UInt32.self
  )
}

func initializeInput(_ allocation: RawBufferAllocation, at base: Int) {
  storeWord(77, in: allocation, at: base)
  let particles: [(mass: UInt32, padding: UInt32, id: UInt32)] = [
    (10, 0xdead_0000, 101),
    (20, 0xdead_0001, 202),
    (30, 0xdead_0002, 303),
    (40, 0xdead_0003, 404),
  ]
  for (index, particle) in particles.enumerated() {
    let particleBase = base + 4 + index * 12
    storeWord(particle.mass, in: allocation, at: particleBase)
    storeWord(particle.padding, in: allocation, at: particleBase + 4)
    storeWord(particle.id, in: allocation, at: particleBase + 8)
  }
}

func readWords(_ allocation: RawBufferAllocation, count: Int) -> [UInt32] {
  let values = allocation.buffer.contents().bindMemory(to: UInt32.self, capacity: count)
  return (0..<count).map { UInt32(littleEndian: values[$0]) }
}

func wordsHex(_ words: [UInt32]) -> String {
  words
    .flatMap { word -> [UInt8] in
      var value = word.littleEndian
      return withUnsafeBytes(of: &value) { Array($0) }
    }
    .map { String(format: "%02x", $0) }
    .joined()
}

func expectPreparationFailure(
  _ label: String,
  expected: String,
  binder: RuntimeSizedMetalBinder,
  resources: [String: BoundBufferRange]
) throws -> String {
  var received: Error?
  do {
    _ = try binder.prepare(resources: resources)
  } catch {
    received = error
  }
  guard let received else {
    try fail("\(label) unexpectedly prepared")
  }
  try require(
    String(describing: received).contains(expected),
    "\(label) returned an unexpected diagnostic: \(received)"
  )
  return label
}

func emit(_ object: [String: Any]) throws {
  let data = try JSONSerialization.data(
    withJSONObject: object,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let string = String(data: data, encoding: .utf8) else {
    try fail("could not encode runtime-sized storage report")
  }
  print(string)
}

func run() throws {
  guard CommandLine.arguments.count == 3 else {
    try fail("usage: runtime-sized-storage-metal <library.metallib> <manifest.json>")
  }
  let manifest = try RuntimeSizedStorageManifest.decode(
    contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
  try manifest.validateRuntimeSupport()
  try assertExpectedManifest(manifest)

  guard let device = MTLCreateSystemDefaultDevice() else {
    try fail("No default Metal device is available")
  }
  let context = MetalRuntimeContext(device: device)
  let (pipeline, reflection) = try makePipeline(
    device: device,
    libraryPath: CommandLine.arguments[1],
    entryPoint: manifest.entry.metal
  )
  let program = try RawMetalComputeProgram(
    context: context,
    manifest: manifest,
    pipeline: pipeline
  )
  let binder = RuntimeSizedMetalBinder(program: program)

  let input = try makeBuffer(
    context: context,
    identity: "runtime-sized-input",
    physicalLength: 1_024,
    logicalLength: 512,
    usage: [.storageRead]
  )
  let shortOutput = try makeBuffer(
    context: context,
    identity: "runtime-sized-short-output",
    physicalLength: 8,
    logicalLength: 8,
    usage: [.storageRead, .storageWrite]
  )
  let longOutput = try makeBuffer(
    context: context,
    identity: "runtime-sized-long-output",
    physicalLength: 8,
    logicalLength: 8,
    usage: [.storageRead, .storageWrite]
  )
  let inputOffset = 256
  initializeInput(input, at: inputOffset)
  let shortInput = BoundBufferRange(allocation: input, offset: inputOffset, rangeBytes: 28)
  let longInput = BoundBufferRange(allocation: input, offset: inputOffset, rangeBytes: 52)
  let shortOutputRange = BoundBufferRange(allocation: shortOutput, offset: 0, rangeBytes: 8)
  let longOutputRange = BoundBufferRange(allocation: longOutput, offset: 0, rangeBytes: 8)
  try require(
    shortInput.allocation === longInput.allocation && shortInput.offset == longInput.offset,
    "runtime-sized storage views do not share one backing generation and offset"
  )

  let shortResources = ["g0b0": shortInput, "g0b1": shortOutputRange]
  let longResources = ["g0b0": longInput, "g0b1": longOutputRange]
  let shortPrepared = try binder.prepare(resources: shortResources)
  let longPrepared = try binder.prepare(resources: longResources)
  try require(
    shortPrepared.immediateWords == [0, 28]
      && longPrepared.immediateWords == [0, 52],
    "runtime-sized storage immediate payload drifted"
  )
  try require(
    shortPrepared.immediateWords.count == 2 && longPrepared.immediateWords.count == 2,
    "fixed output storage extended the runtime size table"
  )

  var negativePreparationChecks: [String] = []
  negativePreparationChecks.append(
    try expectPreparationFailure(
      "below-minimum",
      expected: "below its semantic minimum",
      binder: binder,
      resources: [
        "g0b0": BoundBufferRange(allocation: input, offset: inputOffset, rangeBytes: 12),
        "g0b1": shortOutputRange,
      ]
    ))
  negativePreparationChecks.append(
    try expectPreparationFailure(
      "out-of-bounds",
      expected: "exceeds its logical allocation",
      binder: binder,
      resources: [
        "g0b0": BoundBufferRange(allocation: input, offset: 480, rangeBytes: 52),
        "g0b1": shortOutputRange,
      ]
    ))
  negativePreparationChecks.append(
    try expectPreparationFailure(
      "uint32-overflow",
      expected: "exceeds UInt32",
      binder: binder,
      resources: [
        "g0b0": BoundBufferRange(
          allocation: input,
          offset: inputOffset,
          rangeBytes: Int(UInt32.max) + 1
        ),
        "g0b1": shortOutputRange,
      ]
    ))
  negativePreparationChecks.append(
    try expectPreparationFailure(
      "storage-alignment",
      expected: "storage range is not word-aligned",
      binder: binder,
      resources: [
        "g0b0": BoundBufferRange(allocation: input, offset: inputOffset, rangeBytes: 18),
        "g0b1": shortOutputRange,
      ]
    ))

  guard
    let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer(),
    let encoder = commandBuffer.makeComputeCommandEncoder()
  else {
    try fail("could not create runtime-sized storage command resources")
  }
  try binder.encode(shortPrepared, into: encoder)
  encoder.dispatchThreadgroups(
    MTLSize(width: 1, height: 1, depth: 1),
    threadsPerThreadgroup: manifest.resolvedWorkgroupSize.metalSize
  )
  try binder.encode(longPrepared, into: encoder)
  encoder.dispatchThreadgroups(
    MTLSize(width: 1, height: 1, depth: 1),
    threadsPerThreadgroup: manifest.resolvedWorkgroupSize.metalSize
  )
  encoder.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
  try require(
    commandBuffer.status == .completed && commandBuffer.error == nil,
    "runtime-sized storage dispatch failed: "
      + (commandBuffer.error?.localizedDescription ?? "unknown error")
  )

  let readbacks = [
    readWords(shortOutput, count: 2),
    readWords(longOutput, count: 2),
  ]
  try require(
    readbacks == [[2, 202], [4, 404]],
    "runtime-sized storage readback drifted: \(readbacks)"
  )
  try emit([
    "device": device.name,
    "effectiveRanges": [28, 52],
    "immediateUploads": [
      wordsHex(shortPrepared.immediateWords),
      wordsHex(longPrepared.immediateWords),
    ],
    "negativePreparationChecks": negativePreparationChecks,
    "readbacks": readbacks,
    "reflection": reflection.map(\.report),
    "sameBackingBuffer": shortInput.allocation.buffer === longInput.allocation.buffer,
  ])
}

do {
  try run()
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
