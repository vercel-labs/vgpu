import CoreFoundation
import Foundation
import Metal

struct ResourceMetalProbeError: Error, CustomStringConvertible {
  let description: String
}

func fail(_ message: String) throws -> Never {
  throw ResourceMetalProbeError(description: message)
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
  guard let value = value as? [Any] else {
    try fail("\(owner) must be an array")
  }
  return value
}

func stringValue(_ value: Any?, owner: String) throws -> String {
  guard let value = value as? String else {
    try fail("\(owner) must be a string")
  }
  return value
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
  let integer = number.intValue
  try require(
    integer >= 0 && Double(integer) == number.doubleValue,
    "\(owner) must be an exact UInt32 value"
  )
  return integer
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

enum ShaderStage: String, CaseIterable {
  case vertex
  case fragment
  case compute

  var rank: Int {
    switch self {
    case .vertex: 0
    case .fragment: 1
    case .compute: 2
    }
  }
}

enum ResourceClass: String {
  case buffer
  case texture
  case sampler

  var rank: Int {
    switch self {
    case .buffer: 0
    case .texture: 1
    case .sampler: 2
    }
  }
}

enum SamplerKind: String {
  case filtering
  case nonFiltering = "non-filtering"
  case comparison
}

enum TextureSampleType: String {
  case float
  case unfilterableFloat = "unfilterable-float"
  case depth
  case sint
  case uint
}

struct BufferDescriptor {
  let addressSpace: String
  let access: String
  let minimumBindingSize: Int
  let runtimeSized: Bool
}

struct TextureDescriptor {
  let dimension: String
  let sampleType: TextureSampleType
  let multisampled: Bool
}

struct SamplerDescriptor {
  let kind: SamplerKind
}

enum BindingDescriptor {
  case buffer(BufferDescriptor)
  case texture(TextureDescriptor)
  case sampler(SamplerDescriptor)

  var resourceClass: ResourceClass {
    switch self {
    case .buffer: .buffer
    case .texture: .texture
    case .sampler: .sampler
    }
  }
}

struct ResourceSlot {
  let stage: ShaderStage
  let resourceClass: ResourceClass
  let index: Int
}

struct ResourceBindingLayout {
  let semanticBinding: String
  let descriptor: BindingDescriptor
  let slots: [ResourceSlot]
}

struct SamplingPair {
  let stage: ShaderStage
  let texture: String
  let sampler: String
  let mode: String
}

struct RuntimeResourceLayout {
  let semanticProgram: String
  let kind: String
  let bindings: [ResourceBindingLayout]
  let samplingPairs: [SamplingPair]

  private init(
    semanticProgram: String,
    kind: String,
    bindings: [ResourceBindingLayout],
    samplingPairs: [SamplingPair]
  ) {
    self.semanticProgram = semanticProgram
    self.kind = kind
    self.bindings = bindings
    self.samplingPairs = samplingPairs
  }

  static func decode(_ root: [String: Any]) throws -> RuntimeResourceLayout {
    let bindings = try arrayValue(root["bindings"], owner: "bindings").enumerated().map {
      index, value in
      try decodeBinding(value, owner: "bindings[\(index)]")
    }
    let pairs = try arrayValue(root["samplingPairs"], owner: "samplingPairs").enumerated().map {
      index, value in
      try decodeSamplingPair(value, owner: "samplingPairs[\(index)]")
    }
    let layout = RuntimeResourceLayout(
      semanticProgram: try stringValue(root["semanticProgram"], owner: "semanticProgram"),
      kind: try stringValue(root["kind"], owner: "kind"),
      bindings: bindings,
      samplingPairs: pairs
    )
    try layout.validate()
    return layout
  }

  func validate() throws {
    try require(!semanticProgram.isEmpty, "semanticProgram must not be empty")
    let selectedStages: Set<ShaderStage>
    switch kind {
    case "effect", "draw": selectedStages = [.vertex, .fragment]
    case "compute": selectedStages = [.compute]
    default: try fail("unsupported program kind \(kind)")
    }

    var bindingByID: [String: ResourceBindingLayout] = [:]
    var occupied: Set<String> = []
    for binding in bindings {
      try require(
        binding.semanticBinding.range(
          of: #"^g(?:0|[1-9][0-9]*)b(?:0|[1-9][0-9]*)$"#,
          options: .regularExpression
        ) != nil,
        "invalid semantic binding \(binding.semanticBinding)"
      )
      try require(
        bindingByID.updateValue(binding, forKey: binding.semanticBinding) == nil,
        "duplicate semantic binding \(binding.semanticBinding)"
      )
      try require(!binding.slots.isEmpty, "\(binding.semanticBinding) has no Metal slots")
      var previousRank = -1
      var stages: Set<ShaderStage> = []
      for slot in binding.slots {
        try require(selectedStages.contains(slot.stage), "slot uses an unselected stage")
        try require(slot.stage.rank > previousRank, "slots are not in canonical stage order")
        previousRank = slot.stage.rank
        try require(stages.insert(slot.stage).inserted, "binding repeats a stage")
        try require(
          slot.resourceClass == binding.descriptor.resourceClass,
          "slot class differs from the semantic descriptor"
        )
        let key = "\(slot.stage.rawValue)/\(slot.resourceClass.rawValue)/\(slot.index)"
        try require(occupied.insert(key).inserted, "physical Metal slots collide")
      }
    }

    var previousPairStage = -1
    var observedPairs: Set<String> = []
    for pair in samplingPairs {
      let key = "\(pair.stage.rank)/\(pair.texture)/\(pair.sampler)/\(pair.mode)"
      try require(pair.stage.rank >= previousPairStage, "sampling-pair stages are not canonical")
      previousPairStage = pair.stage.rank
      try require(observedPairs.insert(key).inserted, "sampling pair is duplicated")
      guard
        let texture = bindingByID[pair.texture],
        let sampler = bindingByID[pair.sampler],
        case .texture(let textureDescriptor) = texture.descriptor,
        case .sampler(let samplerDescriptor) = sampler.descriptor
      else {
        try fail("sampling pair does not reference texture and sampler descriptors")
      }
      try require(
        texture.slots.contains { $0.stage == pair.stage }
          && sampler.slots.contains { $0.stage == pair.stage },
        "sampling pair resources are not active in its stage"
      )
      if pair.mode == "comparison" {
        try require(
          samplerDescriptor.kind == .comparison && textureDescriptor.sampleType == .depth,
          "comparison pair is incompatible"
        )
      } else {
        try require(pair.mode == "filtering", "unsupported sampling mode")
        switch samplerDescriptor.kind {
        case .filtering:
          try require(
            ![.unfilterableFloat, .sint, .uint].contains(textureDescriptor.sampleType),
            "filtering sampler cannot sample this texture type"
          )
        case .nonFiltering:
          try require(
            [.unfilterableFloat, .sint, .uint].contains(textureDescriptor.sampleType),
            "non-filtering sampler requires an unfilterable texture type"
          )
        case .comparison:
          try fail("comparison sampler has filtering pair mode")
        }
      }
    }
  }
}

struct ProjectedEntryPoint {
  let stage: ShaderStage
  let metal: String
}

struct RuntimeProbeManifest {
  let layout: RuntimeResourceLayout
  let entryPoints: [ProjectedEntryPoint]

  static func decode(contentsOf url: URL) throws -> RuntimeProbeManifest {
    let data = try Data(contentsOf: url)
    let rootValue = try JSONSerialization.jsonObject(with: data)
    let root = try exactObject(
      rootValue,
      keys: [
        "schemaVersion", "semanticProgram", "kind", "entryPoints", "bindings",
        "samplingPairs",
      ],
      owner: "runtime probe manifest"
    )
    let schemaVersion = try integerValue(root["schemaVersion"], owner: "schemaVersion")
    try require(schemaVersion == 1, "runtime probe manifest schemaVersion must be one")
    let layout = try RuntimeResourceLayout.decode(root)
    let entryPoints = try arrayValue(root["entryPoints"], owner: "entryPoints").enumerated().map {
      index, value in
      let owner = "entryPoints[\(index)]"
      let object = try exactObject(value, keys: ["stage", "metal"], owner: owner)
      guard
        let stage = ShaderStage(
          rawValue: try stringValue(object["stage"], owner: "\(owner).stage")
        )
      else {
        try fail("\(owner) uses an unsupported stage")
      }
      let metal = try stringValue(object["metal"], owner: "\(owner).metal")
      try require(
        metal.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil,
        "\(owner) has an invalid Metal entry name"
      )
      return ProjectedEntryPoint(stage: stage, metal: metal)
    }
    let expectedStages: [ShaderStage] =
      layout.kind == "compute" ? [.compute] : [.vertex, .fragment]
    try require(
      entryPoints.map(\.stage) == expectedStages,
      "runtime probe entry stages differ from the program kind"
    )
    try require(
      Set(entryPoints.map(\.metal)).count == entryPoints.count,
      "runtime probe repeats an emitted Metal name"
    )
    return RuntimeProbeManifest(layout: layout, entryPoints: entryPoints)
  }
}

func decodeBinding(_ value: Any, owner: String) throws -> ResourceBindingLayout {
  let object = try exactObject(
    value,
    keys: ["semanticBinding", "descriptor", "slots"],
    owner: owner
  )
  let semanticBinding = try stringValue(
    object["semanticBinding"],
    owner: "\(owner).semanticBinding"
  )
  let descriptor = try decodeDescriptor(object["descriptor"] as Any, owner: "\(owner).descriptor")
  let slots = try arrayValue(object["slots"], owner: "\(owner).slots").enumerated().map {
    index, value in
    try decodeSlot(value, owner: "\(owner).slots[\(index)]")
  }
  return ResourceBindingLayout(
    semanticBinding: semanticBinding,
    descriptor: descriptor,
    slots: slots
  )
}

func decodeDescriptor(_ value: Any, owner: String) throws -> BindingDescriptor {
  guard let raw = value as? [String: Any] else {
    try fail("\(owner) must be an object")
  }
  let kind = try stringValue(raw["kind"], owner: "\(owner).kind")
  switch kind {
  case "buffer":
    let object = try exactObject(
      value,
      keys: ["kind", "addressSpace", "access", "minimumBindingSize", "runtimeSized"],
      owner: owner
    )
    let addressSpace = try stringValue(object["addressSpace"], owner: "\(owner).addressSpace")
    let access = try stringValue(object["access"], owner: "\(owner).access")
    try require(["uniform", "storage"].contains(addressSpace), "unsupported buffer address space")
    try require(["read", "read_write"].contains(access), "unsupported buffer access")
    try require(
      addressSpace != "uniform" || access == "read",
      "uniform buffers must be read-only"
    )
    return .buffer(
      BufferDescriptor(
        addressSpace: addressSpace,
        access: access,
        minimumBindingSize: try integerValue(
          object["minimumBindingSize"],
          owner: "\(owner).minimumBindingSize"
        ),
        runtimeSized: try boolValue(object["runtimeSized"], owner: "\(owner).runtimeSized")
      )
    )
  case "texture":
    let object = try exactObject(
      value,
      keys: ["kind", "dimension", "sampleType", "multisampled"],
      owner: owner
    )
    let dimension = try stringValue(object["dimension"], owner: "\(owner).dimension")
    try require(
      ["1d", "2d", "2d-array", "cube", "cube-array", "3d"].contains(dimension),
      "unsupported texture dimension"
    )
    guard
      let sampleType = TextureSampleType(
        rawValue: try stringValue(object["sampleType"], owner: "\(owner).sampleType")
      )
    else {
      try fail("unsupported texture sample type")
    }
    return .texture(
      TextureDescriptor(
        dimension: dimension,
        sampleType: sampleType,
        multisampled: try boolValue(object["multisampled"], owner: "\(owner).multisampled")
      )
    )
  case "sampler":
    let object = try exactObject(
      value,
      keys: ["kind", "samplerKind"],
      owner: owner
    )
    guard
      let samplerKind = SamplerKind(
        rawValue: try stringValue(object["samplerKind"], owner: "\(owner).samplerKind")
      )
    else {
      try fail("unsupported sampler kind")
    }
    return .sampler(SamplerDescriptor(kind: samplerKind))
  default:
    try fail("unsupported resource descriptor kind \(kind)")
  }
}

func decodeSlot(_ value: Any, owner: String) throws -> ResourceSlot {
  let object = try exactObject(
    value,
    keys: ["stage", "mode", "resourceClass", "component", "index", "count"],
    owner: owner
  )
  guard
    let stage = ShaderStage(
      rawValue: try stringValue(object["stage"], owner: "\(owner).stage")
    ),
    let resourceClass = ResourceClass(
      rawValue: try stringValue(object["resourceClass"], owner: "\(owner).resourceClass")
    )
  else {
    try fail("\(owner) uses an unsupported stage or resource class")
  }
  let mode = try stringValue(object["mode"], owner: "\(owner).mode")
  let component = try stringValue(object["component"], owner: "\(owner).component")
  let count = try integerValue(object["count"], owner: "\(owner).count")
  try require(mode == "direct", "slot mode must be direct")
  try require(
    component == resourceClass.rawValue,
    "slot component must equal its resource class"
  )
  try require(count == 1, "slot count must be one")
  return ResourceSlot(
    stage: stage,
    resourceClass: resourceClass,
    index: try integerValue(object["index"], owner: "\(owner).index")
  )
}

func decodeSamplingPair(_ value: Any, owner: String) throws -> SamplingPair {
  let object = try exactObject(
    value,
    keys: ["stage", "texture", "sampler", "mode"],
    owner: owner
  )
  guard
    let stage = ShaderStage(
      rawValue: try stringValue(object["stage"], owner: "\(owner).stage")
    )
  else {
    try fail("\(owner) uses an unsupported stage")
  }
  return SamplingPair(
    stage: stage,
    texture: try stringValue(object["texture"], owner: "\(owner).texture"),
    sampler: try stringValue(object["sampler"], owner: "\(owner).sampler"),
    mode: try stringValue(object["mode"], owner: "\(owner).mode")
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

  static let uniform = BufferUsage(rawValue: 1 << 0)
  static let storageRead = BufferUsage(rawValue: 1 << 1)
  static let storageWrite = BufferUsage(rawValue: 1 << 2)
}

final class BufferResource {
  let identity: String
  let context: MetalRuntimeContext
  let buffer: MTLBuffer
  let logicalLength: Int
  let offset: Int
  let rangeBytes: Int
  let usage: BufferUsage

  private init(
    identity: String,
    context: MetalRuntimeContext,
    buffer: MTLBuffer,
    logicalLength: Int,
    offset: Int,
    rangeBytes: Int,
    usage: BufferUsage
  ) {
    self.identity = identity
    self.context = context
    self.buffer = buffer
    self.logicalLength = logicalLength
    self.offset = offset
    self.rangeBytes = rangeBytes
    self.usage = usage
  }

  static func allocate(
    context: MetalRuntimeContext,
    identity: String,
    values: [Float],
    allocationLength: Int = 512,
    logicalLength: Int? = nil,
    offset: Int = 256,
    rangeBytes: Int,
    usage: BufferUsage
  ) throws -> BufferResource {
    try require(allocationLength > 0, "\(identity) allocation length is invalid")
    try require(
      offset >= 0 && offset <= allocationLength,
      "\(identity) physical upload offset is invalid"
    )
    guard
      let buffer = context.device.makeBuffer(
        length: allocationLength,
        options: [.storageModeShared]
      )
    else {
      try fail("could not allocate \(identity)")
    }
    buffer.label = identity
    memset(buffer.contents(), 0xff, allocationLength)
    try values.withUnsafeBytes { bytes in
      try require(
        bytes.count <= rangeBytes,
        "\(identity) packed bytes exceed the bound range"
      )
      try require(
        bytes.count <= allocationLength - offset,
        "\(identity) packed bytes exceed the physical allocation"
      )
      guard let baseAddress = bytes.baseAddress else {
        try fail("\(identity) has no packed bytes")
      }
      memcpy(buffer.contents().advanced(by: offset), baseAddress, bytes.count)
    }
    return BufferResource(
      identity: identity,
      context: context,
      buffer: buffer,
      logicalLength: logicalLength ?? allocationLength,
      offset: offset,
      rangeBytes: rangeBytes,
      usage: usage
    )
  }
}

final class TextureResource {
  let identity: String
  let context: MetalRuntimeContext
  let texture: MTLTexture

  private init(
    identity: String,
    context: MetalRuntimeContext,
    texture: MTLTexture
  ) {
    self.identity = identity
    self.context = context
    self.texture = texture
  }

  static func wrap(
    identity: String,
    context: MetalRuntimeContext,
    texture: MTLTexture
  ) throws -> TextureResource {
    try require(
      texture.device === context.device,
      "\(identity) texture belongs to another Metal device"
    )
    return TextureResource(identity: identity, context: context, texture: texture)
  }
}

struct SamplerConfiguration {
  let minFilter: MTLSamplerMinMagFilter
  let magFilter: MTLSamplerMinMagFilter
  let mipFilter: MTLSamplerMipFilter
  let compareFunction: MTLCompareFunction
  let maxAnisotropy: Int
  let normalizedCoordinates: Bool

  init(descriptor: MTLSamplerDescriptor) {
    minFilter = descriptor.minFilter
    magFilter = descriptor.magFilter
    mipFilter = descriptor.mipFilter
    compareFunction = descriptor.compareFunction
    maxAnisotropy = descriptor.maxAnisotropy
    normalizedCoordinates = descriptor.normalizedCoordinates
  }

  var kind: SamplerKind {
    if compareFunction != .never {
      return .comparison
    }
    if minFilter == .linear || magFilter == .linear || mipFilter == .linear
      || maxAnisotropy > 1
    {
      return .filtering
    }
    return .nonFiltering
  }
}

final class SamplerResource {
  let identity: String
  let context: MetalRuntimeContext
  let state: MTLSamplerState
  let configuration: SamplerConfiguration

  private init(
    identity: String,
    context: MetalRuntimeContext,
    state: MTLSamplerState,
    configuration: SamplerConfiguration
  ) {
    self.identity = identity
    self.context = context
    self.state = state
    self.configuration = configuration
  }

  static func make(
    identity: String,
    context: MetalRuntimeContext,
    descriptor: MTLSamplerDescriptor
  ) throws -> SamplerResource {
    let configuration = SamplerConfiguration(descriptor: descriptor)
    guard let state = context.device.makeSamplerState(descriptor: descriptor) else {
      try fail("could not allocate \(identity)")
    }
    try require(
      state.device === context.device,
      "\(identity) sampler belongs to another Metal device"
    )
    return SamplerResource(
      identity: identity,
      context: context,
      state: state,
      configuration: configuration
    )
  }
}

enum RuntimeResource {
  case buffer(BufferResource)
  case texture(TextureResource)
  case sampler(SamplerResource)

  var identity: String {
    switch self {
    case .buffer(let resource): resource.identity
    case .texture(let resource): resource.identity
    case .sampler(let resource): resource.identity
    }
  }
}

enum PreparedCommand {
  case buffer(String, ShaderStage, Int, BufferResource)
  case texture(String, ShaderStage, Int, TextureResource)
  case sampler(String, ShaderStage, Int, SamplerResource)

  var semanticBinding: String {
    switch self {
    case .buffer(let binding, _, _, _), .texture(let binding, _, _, _),
      .sampler(let binding, _, _, _):
      binding
    }
  }

  var stage: ShaderStage {
    switch self {
    case .buffer(_, let stage, _, _), .texture(_, let stage, _, _),
      .sampler(_, let stage, _, _):
      stage
    }
  }

  var index: Int {
    switch self {
    case .buffer(_, _, let index, _), .texture(_, _, let index, _),
      .sampler(_, _, let index, _):
      index
    }
  }

  var resourceClass: ResourceClass {
    switch self {
    case .buffer: .buffer
    case .texture: .texture
    case .sampler: .sampler
    }
  }

  var resourceIdentity: String {
    switch self {
    case .buffer(_, _, _, let resource): resource.identity
    case .texture(_, _, _, let resource): resource.identity
    case .sampler(_, _, _, let resource): resource.identity
    }
  }

  var bufferResource: BufferResource? {
    if case .buffer(_, _, _, let resource) = self {
      return resource
    }
    return nil
  }

  var report: [String: Any] {
    [
      "semanticBinding": semanticBinding,
      "stage": stage.rawValue,
      "resourceClass": resourceClass.rawValue,
      "index": index,
      "resource": resourceIdentity,
    ]
  }
}

struct PreparedMetalBindings {
  fileprivate let owner: MetalRenderProgram
  fileprivate let commands: [PreparedCommand]
}

final class MetalRenderProgram {
  let context: MetalRuntimeContext
  fileprivate let layout: RuntimeResourceLayout
  fileprivate let pipeline: MTLRenderPipelineState

  init(
    context: MetalRuntimeContext,
    layout: RuntimeResourceLayout,
    pipeline: MTLRenderPipelineState
  ) throws {
    try layout.validate()
    try require(
      ["effect", "draw"].contains(layout.kind),
      "render program requires a render layout"
    )
    try require(
      pipeline.device === context.device,
      "render pipeline belongs to another Metal device"
    )
    self.context = context
    self.layout = layout
    self.pipeline = pipeline
  }
}

struct MetalResourceBinder {
  fileprivate let program: MetalRenderProgram

  func prepare(resources: [String: RuntimeResource]) throws -> PreparedMetalBindings {
    let layout = program.layout
    try layout.validate()
    try require(
      ["effect", "draw"].contains(layout.kind), "render binder requires a render program")
    let expected = Set(layout.bindings.map(\.semanticBinding))
    try require(Set(resources.keys) == expected, "resource set is incomplete or contains extras")

    var commands: [PreparedCommand] = []
    for binding in layout.bindings {
      guard let resource = resources[binding.semanticBinding] else {
        try fail("missing runtime resource \(binding.semanticBinding)")
      }
      switch (binding.descriptor, resource) {
      case (.buffer(let descriptor), .buffer(let buffer)):
        try validate(buffer: buffer, descriptor: descriptor, binding: binding.semanticBinding)
        commands.append(
          contentsOf: binding.slots.map {
            .buffer(binding.semanticBinding, $0.stage, $0.index, buffer)
          })
      case (.texture(let descriptor), .texture(let texture)):
        try validate(texture: texture, descriptor: descriptor, binding: binding.semanticBinding)
        commands.append(
          contentsOf: binding.slots.map {
            .texture(binding.semanticBinding, $0.stage, $0.index, texture)
          })
      case (.sampler(let descriptor), .sampler(let sampler)):
        try validate(sampler: sampler, descriptor: descriptor, binding: binding.semanticBinding)
        commands.append(
          contentsOf: binding.slots.map {
            .sampler(binding.semanticBinding, $0.stage, $0.index, sampler)
          })
      default:
        try fail("runtime resource kind differs for \(binding.semanticBinding)")
      }
    }

    for pair in layout.samplingPairs {
      guard
        case .texture(let texture)? = resources[pair.texture],
        case .sampler(let sampler)? = resources[pair.sampler]
      else {
        try fail("sampling pair resources have incorrect runtime kinds")
      }
      let textureSampleType = try sampleType(
        for: texture.texture,
        binding: pair.texture
      )
      if pair.mode == "comparison" {
        try require(
          sampler.configuration.kind == .comparison && textureSampleType == .depth,
          "runtime comparison pair is incompatible"
        )
      } else if sampler.configuration.kind == .filtering {
        try require(
          ![.unfilterableFloat, .sint, .uint].contains(textureSampleType),
          "runtime filtering pair is incompatible"
        )
      } else {
        try require(
          sampler.configuration.kind == .nonFiltering
            && [.unfilterableFloat, .sint, .uint].contains(textureSampleType),
          "runtime non-filtering pair is incompatible"
        )
      }
    }
    return PreparedMetalBindings(owner: program, commands: commands)
  }

  func encode(_ prepared: PreparedMetalBindings, into encoder: MTLRenderCommandEncoder) throws {
    try require(prepared.owner === program, "prepared bindings belong to another render program")
    try require(
      encoder.device === program.context.device,
      "render encoder belongs to another Metal device"
    )
    try require(
      program.pipeline.device === program.context.device,
      "render pipeline no longer belongs to the program device"
    )
    try require(
      prepared.commands.allSatisfy { $0.stage != .compute },
      "prepared render bindings contain a compute command"
    )
    encoder.setRenderPipelineState(program.pipeline)
    for command in prepared.commands {
      switch command {
      case .buffer(_, let stage, let index, let resource):
        switch stage {
        case .vertex:
          encoder.setVertexBuffer(resource.buffer, offset: resource.offset, index: index)
        case .fragment:
          encoder.setFragmentBuffer(resource.buffer, offset: resource.offset, index: index)
        case .compute:
          try fail("compute binding cannot be encoded into a render encoder")
        }
      case .texture(_, let stage, let index, let resource):
        switch stage {
        case .vertex: encoder.setVertexTexture(resource.texture, index: index)
        case .fragment: encoder.setFragmentTexture(resource.texture, index: index)
        case .compute: try fail("compute binding cannot be encoded into a render encoder")
        }
      case .sampler(_, let stage, let index, let resource):
        switch stage {
        case .vertex: encoder.setVertexSamplerState(resource.state, index: index)
        case .fragment: encoder.setFragmentSamplerState(resource.state, index: index)
        case .compute: try fail("compute binding cannot be encoded into a render encoder")
        }
      }
    }
  }

  private func validate(
    buffer: BufferResource,
    descriptor: BufferDescriptor,
    binding: String
  ) throws {
    try require(buffer.context === program.context, "\(binding) belongs to another context")
    try require(
      buffer.buffer.device === program.context.device,
      "\(binding) buffer belongs to another Metal device"
    )
    try require(
      !descriptor.runtimeSized,
      "\(binding) runtime-sized buffers are not supported by the current Metal binder"
    )
    try require(
      buffer.logicalLength > 0 && buffer.logicalLength <= buffer.buffer.length,
      "\(binding) logical buffer length is invalid"
    )
    try require(
      buffer.offset >= 0 && buffer.offset <= buffer.logicalLength,
      "\(binding) buffer offset is invalid"
    )
    try require(buffer.offset % 4 == 0, "\(binding) buffer offset is not word-aligned")
    try require(
      buffer.rangeBytes > 0
        && buffer.rangeBytes <= Int(UInt32.max)
        && buffer.rangeBytes >= descriptor.minimumBindingSize,
      "\(binding) buffer range is below its semantic minimum"
    )
    try require(
      buffer.rangeBytes <= buffer.logicalLength - buffer.offset,
      "\(binding) buffer range exceeds its logical allocation"
    )
    if descriptor.addressSpace == "uniform" {
      try require(buffer.usage.contains(.uniform), "\(binding) lacks uniform usage")
    } else {
      try require(buffer.usage.contains(.storageRead), "\(binding) lacks storage-read usage")
      try require(buffer.rangeBytes % 4 == 0, "\(binding) storage range is not word-aligned")
      if descriptor.access == "read_write" {
        try require(buffer.usage.contains(.storageWrite), "\(binding) lacks storage-write usage")
      }
    }
  }

  private func validate(
    texture: TextureResource,
    descriptor: TextureDescriptor,
    binding: String
  ) throws {
    try require(texture.context === program.context, "\(binding) belongs to another context")
    try require(
      texture.texture.device === program.context.device,
      "\(binding) texture belongs to another Metal device"
    )
    try require(texture.texture.usage.contains(.shaderRead), "\(binding) lacks shader-read usage")
    try require(!texture.texture.isFramebufferOnly, "\(binding) texture is framebuffer-only")
    let dimension = try dimension(for: texture.texture, binding: binding)
    let sampleType = try sampleType(for: texture.texture, binding: binding)
    let multisampled = texture.texture.sampleCount > 1
    try require(dimension == descriptor.dimension, "\(binding) texture dimension differs")
    try require(
      sampleType == descriptor.sampleType, "\(binding) texture sample type differs")
    try require(multisampled == descriptor.multisampled, "\(binding) sample count differs")
    try require(texture.texture.textureType == .type2D, "current gate accepts only texture2d")
    try require(
      texture.texture.sampleCount == 1, "current gate accepts only single-sample textures")
    try require(texture.texture.pixelFormat == .rgba8Unorm, "current gate accepts only rgba8Unorm")
  }

  private func validate(
    sampler: SamplerResource,
    descriptor: SamplerDescriptor,
    binding: String
  ) throws {
    try require(sampler.context === program.context, "\(binding) belongs to another context")
    try require(
      sampler.state.device === program.context.device,
      "\(binding) sampler belongs to another Metal device"
    )
    try require(
      sampler.configuration.normalizedCoordinates,
      "\(binding) sampler must use normalized coordinates"
    )
    try require(
      sampler.configuration.kind == descriptor.kind,
      "\(binding) sampler kind differs"
    )
  }

  private func dimension(for texture: MTLTexture, binding: String) throws -> String {
    switch texture.textureType {
    case .type1D: return "1d"
    case .type2D, .type2DMultisample: return "2d"
    case .type2DArray, .type2DMultisampleArray: return "2d-array"
    case .typeCube: return "cube"
    case .typeCubeArray: return "cube-array"
    case .type3D: return "3d"
    case .type1DArray, .typeTextureBuffer:
      try fail("\(binding) uses an unsupported Metal texture dimension")
    @unknown default:
      try fail("\(binding) uses an unknown Metal texture dimension")
    }
  }

  private func sampleType(
    for texture: MTLTexture,
    binding: String
  ) throws -> TextureSampleType {
    switch texture.pixelFormat {
    case .rgba8Unorm: return .float
    case .r32Float: return .unfilterableFloat
    case .depth32Float: return .depth
    case .rgba8Sint: return .sint
    case .rgba8Uint: return .uint
    default: try fail("\(binding) uses an unsupported Metal pixel format")
    }
  }
}

func assertExpectedLayout(_ layout: RuntimeResourceLayout) throws {
  try require(layout.semanticProgram == "AssemblyResources", "unexpected semantic program")
  try require(layout.kind == "draw", "resource fixture must be a draw program")
  let rows = layout.bindings.map { binding -> String in
    let descriptor: String
    switch binding.descriptor {
    case .buffer(let value):
      descriptor =
        "buffer/\(value.addressSpace)/\(value.access)/\(value.minimumBindingSize)/\(value.runtimeSized)"
    case .texture(let value):
      descriptor = "texture/\(value.dimension)/\(value.sampleType.rawValue)/\(value.multisampled)"
    case .sampler(let value):
      descriptor = "sampler/\(value.kind.rawValue)"
    }
    let slots = binding.slots.map {
      "\($0.stage.rawValue)/\($0.resourceClass.rawValue)/\($0.index)"
    }.joined(separator: ",")
    return "\(binding.semanticBinding):\(descriptor):\(slots)"
  }
  try require(
    rows == [
      "g0b0:buffer/uniform/read/8/false:vertex/buffer/0,fragment/buffer/0",
      "g0b1:buffer/storage/read/24/false:vertex/buffer/1",
      "g0b2:texture/2d/float/false:fragment/texture/0",
      "g0b3:sampler/filtering:fragment/sampler/0",
      "g0b10:buffer/uniform/read/16/false:fragment/buffer/1",
    ],
    "runtime resource layout differs from the fixed fixture"
  )
  try require(
    layout.samplingPairs.count == 1
      && layout.samplingPairs[0].stage == .fragment
      && layout.samplingPairs[0].texture == "g0b2"
      && layout.samplingPairs[0].sampler == "g0b3"
      && layout.samplingPairs[0].mode == "filtering",
    "runtime sampling pair differs from the fixed fixture"
  )
}

func makeBufferResource(
  context: MetalRuntimeContext,
  identity: String,
  values: [Float],
  rangeBytes: Int,
  usage: BufferUsage
) throws -> BufferResource {
  try BufferResource.allocate(
    context: context,
    identity: identity,
    values: values,
    rangeBytes: rangeBytes,
    usage: usage
  )
}

func makeTextureResource(
  context: MetalRuntimeContext,
  queue: MTLCommandQueue
) throws -> TextureResource {
  try require(
    queue.device === context.device,
    "texture upload queue belongs to another Metal device"
  )
  let descriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm,
    width: 2,
    height: 2,
    mipmapped: false
  )
  descriptor.storageMode = .private
  descriptor.usage = [.shaderRead]
  guard
    let texture = context.device.makeTexture(descriptor: descriptor),
    let staging = context.device.makeBuffer(length: 512, options: [.storageModeShared]),
    let commandBuffer = queue.makeCommandBuffer(),
    let blit = commandBuffer.makeBlitCommandEncoder()
  else {
    try fail("could not allocate albedo texture")
  }
  texture.label = "albedo-texture"
  staging.label = "albedo-upload"
  memset(staging.contents(), 0, staging.length)
  let firstRow: [UInt8] = [
    0, 0, 0, 255,
    64, 128, 0, 255,
  ]
  let secondRow: [UInt8] = [
    128, 0, 128, 255,
    192, 128, 128, 255,
  ]
  _ = firstRow.withUnsafeBytes { bytes in
    memcpy(staging.contents(), bytes.baseAddress!, bytes.count)
  }
  _ = secondRow.withUnsafeBytes { bytes in
    memcpy(staging.contents().advanced(by: 256), bytes.baseAddress!, bytes.count)
  }
  blit.copy(
    from: staging,
    sourceOffset: 0,
    sourceBytesPerRow: 256,
    sourceBytesPerImage: 512,
    sourceSize: MTLSize(width: 2, height: 2, depth: 1),
    to: texture,
    destinationSlice: 0,
    destinationLevel: 0,
    destinationOrigin: MTLOrigin(x: 0, y: 0, z: 0)
  )
  blit.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
  try require(
    commandBuffer.status == .completed && commandBuffer.error == nil,
    "texture upload failed: \(commandBuffer.error?.localizedDescription ?? "unknown error")"
  )
  return try TextureResource.wrap(
    identity: "albedo-texture",
    context: context,
    texture: texture
  )
}

func makeTextureResource(
  context: MetalRuntimeContext,
  identity: String,
  descriptor: MTLTextureDescriptor
) throws -> TextureResource {
  guard let texture = context.device.makeTexture(descriptor: descriptor) else {
    try fail("could not allocate \(identity)")
  }
  texture.label = identity
  return try TextureResource.wrap(
    identity: identity,
    context: context,
    texture: texture
  )
}

func makeSamplerResource(context: MetalRuntimeContext) throws -> SamplerResource {
  let descriptor = MTLSamplerDescriptor()
  descriptor.minFilter = .linear
  descriptor.magFilter = .linear
  descriptor.mipFilter = .notMipmapped
  descriptor.sAddressMode = .clampToEdge
  descriptor.tAddressMode = .clampToEdge
  descriptor.rAddressMode = .clampToEdge
  descriptor.normalizedCoordinates = true
  return try SamplerResource.make(
    identity: "albedo-sampler",
    context: context,
    descriptor: descriptor
  )
}

func expectPreparationFailure(
  _ label: String,
  binder: MetalResourceBinder,
  resources: [String: RuntimeResource]
) throws -> String {
  let expectedDiagnostics = [
    "missing": "resource set is incomplete or contains extras",
    "extra": "resource set is incomplete or contains extras",
    "wrong-kind": "runtime resource kind differs for g0b2",
    "undersized": "g0b0 buffer range is below its semantic minimum",
    "out-of-bounds": "g0b10 buffer range exceeds its logical allocation",
    "context": "g0b0 belongs to another context",
    "buffer-usage": "g0b10 lacks uniform usage",
    "texture-dimension": "g0b2 texture dimension differs",
    "texture-sample-type": "g0b2 texture sample type differs",
    "texture-multisample": "g0b2 sample count differs",
    "texture-usage": "g0b2 lacks shader-read usage",
    "sampler-kind": "g0b3 sampler kind differs",
    "storage-alignment": "g0b1 storage range is not word-aligned",
    "offset-alignment": "g0b1 buffer offset is not word-aligned",
    "runtime-sized": "g0b1 runtime-sized buffers are not supported",
  ]
  guard let expected = expectedDiagnostics[label] else {
    try fail("unknown preparation negative \(label)")
  }
  do {
    _ = try binder.prepare(resources: resources)
  } catch let error as ResourceMetalProbeError {
    try require(
      error.description.contains(expected),
      "\(label) rejected for the wrong reason: \(error.description)"
    )
    return label
  } catch {
    try fail("\(label) rejected with an unexpected error type: \(error)")
  }
  try fail("\(label) escaped resource preparation")
}

func expectEncodingFailure(
  _ label: String,
  binder: MetalResourceBinder,
  prepared: PreparedMetalBindings,
  encoder: MTLRenderCommandEncoder
) throws -> String {
  let expectedDiagnostics = [
    "program-a-to-b": "prepared bindings belong to another render program",
    "program-b-to-a": "prepared bindings belong to another render program",
    "encoder-device": "render encoder belongs to another Metal device",
  ]
  guard let expected = expectedDiagnostics[label] else {
    try fail("unknown encoding negative \(label)")
  }
  do {
    try binder.encode(prepared, into: encoder)
  } catch let error as ResourceMetalProbeError {
    try require(
      error.description.contains(expected),
      "\(label) rejected for the wrong reason: \(error.description)"
    )
    return label
  } catch {
    try fail("\(label) rejected with an unexpected error type: \(error)")
  }
  try fail("\(label) escaped binding encode")
}

func expectRenderProgramFailure(
  _ label: String,
  context: MetalRuntimeContext,
  layout: RuntimeResourceLayout,
  pipeline: MTLRenderPipelineState
) throws -> String {
  let expectedDiagnostics = [
    "pipeline-device": "render pipeline belongs to another Metal device"
  ]
  guard let expected = expectedDiagnostics[label] else {
    try fail("unknown render-program negative \(label)")
  }
  do {
    _ = try MetalRenderProgram(context: context, layout: layout, pipeline: pipeline)
  } catch let error as ResourceMetalProbeError {
    try require(
      error.description.contains(expected),
      "\(label) rejected for the wrong reason: \(error.description)"
    )
    return label
  } catch {
    try fail("\(label) rejected with an unexpected error type: \(error)")
  }
  try fail("\(label) escaped render-program construction")
}

func runtimeSizedLayoutVariant(contentsOf url: URL) throws -> RuntimeResourceLayout {
  let data = try Data(contentsOf: url)
  guard
    var root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    var bindings = root["bindings"] as? [[String: Any]],
    let bindingIndex = bindings.firstIndex(where: { $0["semanticBinding"] as? String == "g0b1" }),
    var descriptor = bindings[bindingIndex]["descriptor"] as? [String: Any]
  else {
    try fail("could not build the runtime-sized layout negative")
  }
  descriptor["runtimeSized"] = true
  bindings[bindingIndex]["descriptor"] = descriptor
  root["bindings"] = bindings
  return try RuntimeResourceLayout.decode(root)
}

func reflectedRows(_ bindings: [MTLBinding]) throws -> [String] {
  try bindings.map { binding in
    try require(binding.isUsed, "pipeline reflection exposed an unused binding")
    try require(binding.isArgument, "pipeline reflection binding is not a direct function argument")
    let resourceClass: ResourceClass
    let details: String
    switch binding.type {
    case .buffer:
      guard let buffer = binding as? MTLBufferBinding else {
        try fail("buffer reflection has no buffer metadata")
      }
      resourceClass = .buffer
      details = "\(binding.name)/\(buffer.bufferDataSize)/\(buffer.bufferAlignment)"
    case .texture:
      guard let texture = binding as? MTLTextureBinding else {
        try fail("texture reflection has no texture metadata")
      }
      try require(
        texture.textureType == .type2D
          && texture.textureDataType == .float
          && !texture.isDepthTexture
          && texture.arrayLength == 1,
        "texture reflection differs from the fixed sampled-texture profile"
      )
      resourceClass = .texture
      details = binding.name
    case .sampler:
      resourceClass = .sampler
      details = binding.name
    default: try fail("pipeline reflection exposed unsupported binding type \(binding.type)")
    }
    return "\(resourceClass.rawValue)/\(binding.index)/\(details)"
  }.sorted { left, right in
    let leftParts = left.split(separator: "/")
    let rightParts = right.split(separator: "/")
    let leftClass = ResourceClass(rawValue: String(leftParts[0]))!
    let rightClass = ResourceClass(rawValue: String(rightParts[0]))!
    return leftClass.rank < rightClass.rank
      || (leftClass.rank == rightClass.rank && Int(leftParts[1])! < Int(rightParts[1])!)
  }
}

func probeEncodingFailure(
  _ label: String,
  binder: MetalResourceBinder,
  prepared: PreparedMetalBindings,
  device: MTLDevice
) throws -> String {
  let descriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm,
    width: 2,
    height: 2,
    mipmapped: false
  )
  descriptor.storageMode = .private
  descriptor.usage = [.renderTarget]
  guard
    let target = device.makeTexture(descriptor: descriptor),
    let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer()
  else {
    try fail("could not allocate the \(label) encoding negative")
  }
  let renderPass = MTLRenderPassDescriptor()
  renderPass.colorAttachments[0].texture = target
  renderPass.colorAttachments[0].loadAction = .dontCare
  renderPass.colorAttachments[0].storeAction = .dontCare
  guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPass) else {
    try fail("could not create the \(label) render encoder")
  }
  do {
    let result = try expectEncodingFailure(
      label,
      binder: binder,
      prepared: prepared,
      encoder: encoder
    )
    encoder.endEncoding()
    return result
  } catch {
    encoder.endEncoding()
    throw error
  }
}

func render(
  queue: MTLCommandQueue,
  binder: MetalResourceBinder,
  prepared: PreparedMetalBindings
) throws -> [UInt8] {
  let program = binder.program
  let device = program.context.device
  try require(queue.device === device, "render queue belongs to another Metal device")
  let descriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm,
    width: 2,
    height: 2,
    mipmapped: false
  )
  descriptor.storageMode = .private
  descriptor.usage = [.renderTarget]
  guard
    let target = device.makeTexture(descriptor: descriptor),
    let readback = device.makeBuffer(length: 512, options: [.storageModeShared]),
    let commandBuffer = queue.makeCommandBuffer()
  else {
    try fail("could not allocate render/readback resources")
  }

  let renderPass = MTLRenderPassDescriptor()
  renderPass.colorAttachments[0].texture = target
  renderPass.colorAttachments[0].loadAction = .clear
  renderPass.colorAttachments[0].storeAction = .store
  renderPass.colorAttachments[0].clearColor = MTLClearColorMake(1, 0, 1, 1)
  guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPass) else {
    try fail("could not create render encoder")
  }
  encoder.setViewport(
    MTLViewport(originX: 0, originY: 0, width: 2, height: 2, znear: 0, zfar: 1)
  )
  encoder.setCullMode(.none)
  try binder.encode(prepared, into: encoder)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.endEncoding()

  guard let blit = commandBuffer.makeBlitCommandEncoder() else {
    try fail("could not create readback encoder")
  }
  blit.copy(
    from: target,
    sourceSlice: 0,
    sourceLevel: 0,
    sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
    sourceSize: MTLSize(width: 2, height: 2, depth: 1),
    to: readback,
    destinationOffset: 0,
    destinationBytesPerRow: 256,
    destinationBytesPerImage: 512
  )
  blit.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
  try require(
    commandBuffer.status == .completed && commandBuffer.error == nil,
    "Metal command buffer failed: \(commandBuffer.error?.localizedDescription ?? "unknown error")"
  )
  let bytes = readback.contents().bindMemory(to: UInt8.self, capacity: 512)
  return (0..<2).flatMap { row in
    (0..<2).flatMap { column in
      (0..<4).map { component in bytes[row * 256 + column * 4 + component] }
    }
  }
}

func runProbe() throws {
  guard CommandLine.arguments.count == 3 else {
    throw ResourceMetalProbeError(
      description: "Usage: resource-metal <metallib> <runtime-manifest-json>"
    )
  }

  let libraryURL = URL(fileURLWithPath: CommandLine.arguments[1])
  let manifestURL = URL(fileURLWithPath: CommandLine.arguments[2])
  let manifest = try RuntimeProbeManifest.decode(contentsOf: manifestURL)
  let layout = manifest.layout
  let entryPoints = Dictionary(
    uniqueKeysWithValues: manifest.entryPoints.map { ($0.stage, $0.metal) }
  )
  guard
    let vertexName = entryPoints[.vertex],
    let fragmentName = entryPoints[.fragment]
  else {
    throw ResourceMetalProbeError(description: "runtime manifest omitted render entry points")
  }
  try assertExpectedLayout(layout)

  guard let device = MTLCreateSystemDefaultDevice() else {
    throw ResourceMetalProbeError(description: "No default Metal device is available.")
  }
  let context = MetalRuntimeContext(device: device)
  let otherContext = MetalRuntimeContext(device: device)
  guard let queue = device.makeCommandQueue() else {
    throw ResourceMetalProbeError(description: "could not create Metal command queue")
  }
  let library = try device.makeLibrary(URL: libraryURL)
  guard
    let vertexFunction = library.makeFunction(name: vertexName),
    let fragmentFunction = library.makeFunction(name: fragmentName)
  else {
    throw ResourceMetalProbeError(description: "metallib omitted projected resource entry points")
  }

  let pipelineDescriptor = MTLRenderPipelineDescriptor()
  pipelineDescriptor.vertexFunction = vertexFunction
  pipelineDescriptor.fragmentFunction = fragmentFunction
  pipelineDescriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
  var reflection: MTLRenderPipelineReflection?
  let pipeline = try device.makeRenderPipelineState(
    descriptor: pipelineDescriptor,
    options: [.bindingInfo],
    reflection: &reflection
  )
  guard let reflection else {
    throw ResourceMetalProbeError(description: "resource pipeline returned no binding reflection")
  }
  let vertexReflection = try reflectedRows(reflection.vertexBindings)
  let fragmentReflection = try reflectedRows(reflection.fragmentBindings)
  try require(
    vertexReflection == ["buffer/0/frame/8/8", "buffer/1/vertices/24/8"],
    "unexpected vertex reflection"
  )
  try require(
    fragmentReflection == [
      "buffer/0/frame/8/8",
      "buffer/1/material/16/16",
      "texture/0/albedo",
      "sampler/0/albedo_sampler",
    ],
    "unexpected fragment reflection"
  )

  let frame = try makeBufferResource(
    context: context,
    identity: "frame-buffer",
    values: [0.2, 0.2],
    rangeBytes: 8,
    usage: [.uniform]
  )
  let vertices = try makeBufferResource(
    context: context,
    identity: "vertices-buffer",
    values: [-0.8, -0.8, 0.5, -0.8, -0.8, 0.5],
    rangeBytes: 24,
    usage: [.storageRead]
  )
  let material = try makeBufferResource(
    context: context,
    identity: "material-buffer",
    values: [0.5, 1, 0.5, 0.5],
    rangeBytes: 16,
    usage: [.uniform]
  )
  let texture = try makeTextureResource(context: context, queue: queue)
  let sampler = try makeSamplerResource(context: context)
  var resources: [String: RuntimeResource] = [
    "g0b0": .buffer(frame),
    "g0b1": .buffer(vertices),
    "g0b2": .texture(texture),
    "g0b3": .sampler(sampler),
    "g0b10": .buffer(material),
  ]
  let program = try MetalRenderProgram(
    context: context,
    layout: layout,
    pipeline: pipeline
  )
  let binder = MetalResourceBinder(program: program)

  var negativeLabels: [String] = []
  var missing = resources
  missing.removeValue(forKey: "g0b10")
  negativeLabels.append(
    try expectPreparationFailure("missing", binder: binder, resources: missing)
  )
  var extra = resources
  extra["g0b99"] = .buffer(frame)
  negativeLabels.append(
    try expectPreparationFailure("extra", binder: binder, resources: extra)
  )
  var wrongKind = resources
  wrongKind["g0b2"] = .buffer(frame)
  negativeLabels.append(
    try expectPreparationFailure("wrong-kind", binder: binder, resources: wrongKind)
  )
  var undersized = resources
  undersized["g0b0"] = .buffer(
    try BufferResource.allocate(
      context: context,
      identity: "undersized-frame",
      values: [0.2],
      rangeBytes: 4,
      usage: [.uniform]
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("undersized", binder: binder, resources: undersized)
  )
  var outOfBounds = resources
  outOfBounds["g0b10"] = .buffer(
    try BufferResource.allocate(
      context: context,
      identity: "out-of-bounds-material",
      values: [0.5, 1, 0.5, 0.5],
      logicalLength: 264,
      offset: 256,
      rangeBytes: 16,
      usage: [.uniform]
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("out-of-bounds", binder: binder, resources: outOfBounds)
  )
  var crossedContext = resources
  crossedContext["g0b0"] = .buffer(
    try BufferResource.allocate(
      context: otherContext,
      identity: "crossed-frame",
      values: [0.2, 0.2],
      rangeBytes: 8,
      usage: [.uniform]
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("context", binder: binder, resources: crossedContext)
  )
  var wrongBufferUsage = resources
  wrongBufferUsage["g0b10"] = .buffer(
    try BufferResource.allocate(
      context: context,
      identity: "wrong-buffer-usage",
      values: [0.5, 1, 0.5, 0.5],
      rangeBytes: 16,
      usage: []
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("buffer-usage", binder: binder, resources: wrongBufferUsage)
  )

  let wrongDimensionDescriptor = MTLTextureDescriptor()
  wrongDimensionDescriptor.textureType = .type3D
  wrongDimensionDescriptor.pixelFormat = .rgba8Unorm
  wrongDimensionDescriptor.width = 2
  wrongDimensionDescriptor.height = 2
  wrongDimensionDescriptor.depth = 2
  wrongDimensionDescriptor.storageMode = .private
  wrongDimensionDescriptor.usage = [.shaderRead]
  var wrongDimension = resources
  wrongDimension["g0b2"] = .texture(
    try makeTextureResource(
      context: context,
      identity: "wrong-dimension",
      descriptor: wrongDimensionDescriptor
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("texture-dimension", binder: binder, resources: wrongDimension)
  )

  let wrongSampleTypeDescriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Uint,
    width: 2,
    height: 2,
    mipmapped: false
  )
  wrongSampleTypeDescriptor.storageMode = .private
  wrongSampleTypeDescriptor.usage = [.shaderRead]
  var wrongSampleType = resources
  wrongSampleType["g0b2"] = .texture(
    try makeTextureResource(
      context: context,
      identity: "wrong-sample-type",
      descriptor: wrongSampleTypeDescriptor
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("texture-sample-type", binder: binder, resources: wrongSampleType)
  )

  let wrongMultisampleDescriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm,
    width: 2,
    height: 2,
    mipmapped: false
  )
  wrongMultisampleDescriptor.textureType = .type2DMultisample
  wrongMultisampleDescriptor.sampleCount = 4
  wrongMultisampleDescriptor.storageMode = .private
  wrongMultisampleDescriptor.usage = [.shaderRead, .renderTarget]
  var wrongMultisample = resources
  wrongMultisample["g0b2"] = .texture(
    try makeTextureResource(
      context: context,
      identity: "wrong-multisample",
      descriptor: wrongMultisampleDescriptor
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("texture-multisample", binder: binder, resources: wrongMultisample)
  )
  let noShaderReadDescriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm,
    width: 2,
    height: 2,
    mipmapped: false
  )
  noShaderReadDescriptor.storageMode = .private
  noShaderReadDescriptor.usage = [.renderTarget]
  var wrongTextureUsage = resources
  wrongTextureUsage["g0b2"] = .texture(
    try makeTextureResource(
      context: context,
      identity: "wrong-texture-usage",
      descriptor: noShaderReadDescriptor
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("texture-usage", binder: binder, resources: wrongTextureUsage)
  )

  let wrongSamplerDescriptor = MTLSamplerDescriptor()
  wrongSamplerDescriptor.compareFunction = .less
  wrongSamplerDescriptor.normalizedCoordinates = true
  var wrongSampler = resources
  wrongSampler["g0b3"] = .sampler(
    try SamplerResource.make(
      identity: "wrong-sampler-kind",
      context: context,
      descriptor: wrongSamplerDescriptor
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("sampler-kind", binder: binder, resources: wrongSampler)
  )
  var unalignedStorage = resources
  unalignedStorage["g0b1"] = .buffer(
    try BufferResource.allocate(
      context: context,
      identity: "unaligned-storage",
      values: [-0.8, -0.8, 0.5, -0.8, -0.8, 0.5],
      rangeBytes: 25,
      usage: [.storageRead]
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("storage-alignment", binder: binder, resources: unalignedStorage)
  )

  var unalignedOffset = resources
  unalignedOffset["g0b1"] = .buffer(
    try BufferResource.allocate(
      context: context,
      identity: "unaligned-offset",
      values: [-0.8, -0.8, 0.5, -0.8, -0.8, 0.5],
      offset: 257,
      rangeBytes: 24,
      usage: [.storageRead]
    )
  )
  negativeLabels.append(
    try expectPreparationFailure("offset-alignment", binder: binder, resources: unalignedOffset)
  )

  let runtimeSizedLayout = try runtimeSizedLayoutVariant(contentsOf: manifestURL)
  let runtimeSizedProgram = try MetalRenderProgram(
    context: context,
    layout: runtimeSizedLayout,
    pipeline: pipeline
  )
  let runtimeSizedBinder = MetalResourceBinder(program: runtimeSizedProgram)
  negativeLabels.append(
    try expectPreparationFailure("runtime-sized", binder: runtimeSizedBinder, resources: resources)
  )

  let preparedResources = resources
  let prepared = try binder.prepare(resources: preparedResources)
  let equivalentProgram = try MetalRenderProgram(
    context: context,
    layout: layout,
    pipeline: pipeline
  )
  let equivalentBinder = MetalResourceBinder(program: equivalentProgram)
  let equivalentPrepared = try equivalentBinder.prepare(resources: preparedResources)
  var negativeEncodingLabels = [
    try probeEncodingFailure(
      "program-a-to-b",
      binder: equivalentBinder,
      prepared: prepared,
      device: device
    ),
    try probeEncodingFailure(
      "program-b-to-a",
      binder: binder,
      prepared: equivalentPrepared,
      device: device
    ),
  ]
  var conditionalDeviceLabels: [String] = []
  if let alternateDevice = MTLCopyAllDevices().first(where: { $0 !== device }) {
    let alternateContext = MetalRuntimeContext(device: alternateDevice)
    conditionalDeviceLabels.append(
      try expectRenderProgramFailure(
        "pipeline-device",
        context: alternateContext,
        layout: layout,
        pipeline: pipeline
      )
    )
    negativeEncodingLabels.append(
      try probeEncodingFailure(
        "encoder-device",
        binder: binder,
        prepared: prepared,
        device: alternateDevice
      )
    )
  }
  let originalFrameCommands = prepared.commands.filter { $0.semanticBinding == "g0b0" }
  try require(originalFrameCommands.count == 2, "shared frame did not fan out to two stages")
  try require(
    originalFrameCommands.allSatisfy { $0.bufferResource === frame },
    "shared frame fan-out changed resource identity"
  )
  let vertexBufferOne = prepared.commands.first {
    $0.stage == .vertex && $0.resourceClass == .buffer && $0.index == 1
  }
  let fragmentBufferOne = prepared.commands.first {
    $0.stage == .fragment && $0.resourceClass == .buffer && $0.index == 1
  }
  try require(
    vertexBufferOne?.bufferResource === vertices
      && fragmentBufferOne?.bufferResource === material
      && vertexBufferOne?.bufferResource !== fragmentBufferOne?.bufferResource,
    "stage-local buffer(1) resources were collapsed"
  )
  let decoyFrame = try makeBufferResource(
    context: context,
    identity: "post-prepare-decoy-frame",
    values: [0, 0],
    rangeBytes: 8,
    usage: [.uniform]
  )
  resources["g0b0"] = .buffer(decoyFrame)
  try require(
    prepared.commands.filter { $0.semanticBinding == "g0b0" }.allSatisfy {
      $0.resourceIdentity == frame.identity
    },
    "prepared bindings observed a later resource-set mutation"
  )
  try require(
    !prepared.commands.contains { $0.index == 10 || $0.index == 30 },
    "prepared bindings leaked WGSL indices or candidate internal slots"
  )

  let firstReadback = try render(
    queue: queue,
    binder: MetalResourceBinder(program: program),
    prepared: prepared
  )
  let secondReadback = try render(
    queue: queue,
    binder: binder,
    prepared: prepared
  )
  let expectedReadback: [UInt8] = [
    99, 115, 32, 128,
    255, 0, 255, 255,
    99, 115, 32, 128,
    99, 115, 32, 128,
  ]
  try require(
    firstReadback == expectedReadback, "unexpected fixed-resource readback \(firstReadback)")
  try require(secondReadback == firstReadback, "fixed-resource readback is not deterministic")

  let report: [String: Any] = [
    "commands": prepared.commands.map(\.report),
    "conditionalDeviceChecks": conditionalDeviceLabels,
    "device": device.name,
    "fragmentReflection": fragmentReflection,
    "negativeEncodingChecks": negativeEncodingLabels,
    "negativePreparationChecks": negativeLabels,
    "readback": firstReadback,
    "vertexReflection": vertexReflection,
  ]
  let reportData = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
  guard let reportJSON = String(data: reportData, encoding: .utf8) else {
    throw ResourceMetalProbeError(description: "could not encode resource probe report")
  }
  print(reportJSON)
}

do {
  try runProbe()
} catch let error as ResourceMetalProbeError {
  FileHandle.standardError.write(Data("\(error.description)\n".utf8))
  exit(EXIT_FAILURE)
} catch {
  FileHandle.standardError.write(Data("unexpected resource probe error: \(error)\n".utf8))
  exit(EXIT_FAILURE)
}
