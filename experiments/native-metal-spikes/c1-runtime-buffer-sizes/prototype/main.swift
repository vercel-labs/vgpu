import Darwin
import Foundation
import Metal

struct SpikeFailure: Error, CustomStringConvertible {
  let description: String
}

struct ReflectedBuffer: Equatable {
  let index: Int
  let dataSize: Int
  let alignment: Int
}

struct ComputeResults: Equatable {
  let canonical: [UInt32]
  let rebound: [UInt32]
  let allStorageCompatibility: [UInt32]
  let densePoison: [UInt32]
}

enum Transport: String {
  case immediate
  case ubo
}

func fail(_ message: String) throws -> Never {
  throw SpikeFailure(description: message)
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() {
    try fail(message)
  }
}

func emit(_ object: [String: Any]) throws {
  let data = try JSONSerialization.data(
    withJSONObject: object,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let string = String(data: data, encoding: .utf8) else {
    try fail("could not encode result as UTF-8")
  }
  print(string)
}

func compileLibrary(device: MTLDevice, path: String) throws -> MTLLibrary {
  let source = try String(contentsOfFile: path, encoding: .utf8)
  let options = MTLCompileOptions()
  options.languageVersion = .version2_4
  return try device.makeLibrary(source: source, options: options)
}

func makeOutputBuffer(device: MTLDevice, label: String) throws -> MTLBuffer {
  guard
    let buffer = device.makeBuffer(
      length: MemoryLayout<UInt32>.stride * 10,
      options: .storageModeShared
    )
  else {
    try fail("could not create \(label)")
  }
  buffer.label = label
  memset(buffer.contents(), 0xff, buffer.length)
  return buffer
}

func readWords(_ buffer: MTLBuffer, count: Int) -> [UInt32] {
  let words = buffer.contents().bindMemory(to: UInt32.self, capacity: count)
  return (0..<count).map { UInt32(littleEndian: words[$0]) }
}

func bytesHex(_ words: [UInt32]) -> String {
  return
    words
    .flatMap { word -> [UInt8] in
      let littleEndian = word.littleEndian
      return withUnsafeBytes(of: littleEndian) { Array($0) }
    }
    .map { String(format: "%02x", $0) }
    .joined()
}

func reflectedBuffers(_ bindings: [MTLBinding]) -> [ReflectedBuffer] {
  return
    bindings
    .filter { $0.type == .buffer && $0.isUsed }
    .map { binding -> ReflectedBuffer in
      let buffer = binding as! MTLBufferBinding
      return ReflectedBuffer(
        index: Int(buffer.index),
        dataSize: Int(buffer.bufferDataSize),
        alignment: Int(buffer.bufferAlignment)
      )
    }
    .sorted { $0.index < $1.index }
}

func makeComputePipeline(
  device: MTLDevice,
  path: String
) throws -> (state: MTLComputePipelineState, buffers: [ReflectedBuffer]) {
  let library = try compileLibrary(device: device, path: path)
  guard let function = library.makeFunction(name: "vgpu_multi_runtime_cross_row") else {
    try fail("generated library omitted vgpu_multi_runtime_cross_row")
  }
  var reflection: MTLComputePipelineReflection?
  let state = try device.makeComputePipelineState(
    function: function,
    options: .bindingInfo,
    reflection: &reflection
  )
  guard let reflection else {
    try fail("compute pipeline returned no binding reflection")
  }
  return (state, reflectedBuffers(reflection.bindings))
}

func makeVertexDescriptor() -> MTLVertexDescriptor {
  let descriptor = MTLVertexDescriptor()
  descriptor.attributes[0].format = .float4
  descriptor.attributes[0].offset = 0
  descriptor.attributes[0].bufferIndex = 29
  descriptor.layouts[29].stride = MemoryLayout<SIMD4<Float>>.stride
  descriptor.layouts[29].stepFunction = .perVertex
  descriptor.layouts[29].stepRate = 1
  return descriptor
}

func makeRenderPipeline(
  device: MTLDevice,
  vertexPath: String,
  fragmentPath: String
) throws -> (
  vertexBuffers: [ReflectedBuffer],
  fragmentBuffers: [ReflectedBuffer],
  vertexStreamIndex: Int
) {
  let vertexLibrary = try compileLibrary(device: device, path: vertexPath)
  let fragmentLibrary = try compileLibrary(device: device, path: fragmentPath)
  guard
    let vertexFunction = vertexLibrary.makeFunction(name: "vgpu_stage_local_vertex"),
    let fragmentFunction = fragmentLibrary.makeFunction(name: "vgpu_stage_local_fragment")
  else {
    try fail("stage-local generated libraries omitted their remapped entry points")
  }
  let descriptor = MTLRenderPipelineDescriptor()
  descriptor.vertexFunction = vertexFunction
  descriptor.fragmentFunction = fragmentFunction
  let vertexDescriptor = makeVertexDescriptor()
  descriptor.vertexDescriptor = vertexDescriptor
  descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
  var reflection: MTLRenderPipelineReflection?
  _ = try device.makeRenderPipelineState(
    descriptor: descriptor,
    options: .bindingInfo,
    reflection: &reflection
  )
  guard let reflection else {
    try fail("stage-local render pipeline returned no binding reflection")
  }
  return (
    reflectedBuffers(reflection.vertexBindings),
    reflectedBuffers(reflection.fragmentBindings),
    Int(vertexDescriptor.attributes[0].bufferIndex)
  )
}

func uploadWords(_ table: [UInt32], transport: Transport) throws -> [UInt32] {
  try require(table.count == 8, "comparison table must contain eight UBO words")
  if transport == .ubo {
    return table
  }
  return [0] + Array(table.prefix(6)) + [0]
}

func dispatch(
  encoder: MTLComputeCommandEncoder,
  output: MTLBuffer,
  table: [UInt32],
  transport: Transport
) throws {
  let upload = try uploadWords(table, transport: transport)
  try require(upload.count == 8, "Metal setBytes upload must be 32 bytes")
  encoder.setBuffer(output, offset: 0, index: 1)
  upload.map(\.littleEndian).withUnsafeBytes { bytes in
    encoder.setBytes(bytes.baseAddress!, length: bytes.count, index: 30)
  }
  encoder.dispatchThreads(
    MTLSize(width: 1, height: 1, depth: 1),
    threadsPerThreadgroup: MTLSize(width: 1, height: 1, depth: 1)
  )
}

func runComputeSuite(
  device: MTLDevice,
  pipeline: MTLComputePipelineState,
  transport: Transport
) throws -> ComputeResults {
  let backingLength = 2_048
  guard
    let backing = device.makeBuffer(length: backingLength, options: .storageModeShared),
    let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer(),
    let encoder = commandBuffer.makeComputeCommandEncoder()
  else {
    try fail("could not create \(transport.rawValue) Metal runtime resources")
  }
  backing.label = "\(transport.rawValue)-shared-oversized-runtime-storage"
  memset(backing.contents(), 0, backing.length)
  let offsets = [0, 256, 512, 768, 1_024]
  encoder.setComputePipelineState(pipeline)
  encoder.setBuffer(backing, offset: offsets[0], index: 0)
  encoder.setBuffer(backing, offset: offsets[1], index: 2)
  encoder.setBuffer(backing, offset: offsets[2], index: 3)
  encoder.setBuffer(backing, offset: offsets[3], index: 4)
  encoder.setBuffer(backing, offset: offsets[4], index: 5)

  let canonical: [UInt32] = [32, 0, 32, 36, 20, 112, 0, 0]
  let rebound: [UInt32] = [48, 0, 40, 40, 24, 128, 0, 0]
  let allStorageCompatibility: [UInt32] = [32, 40, 32, 36, 20, 112, 0, 0]
  let densePoison: [UInt32] = [32, 32, 36, 20, 112, 0, 0, 0]
  let canonicalOutput = try makeOutputBuffer(
    device: device,
    label: "\(transport.rawValue)-canonical-output"
  )
  let reboundOutput = try makeOutputBuffer(
    device: device,
    label: "\(transport.rawValue)-rebound-output"
  )
  let allStorageOutput = try makeOutputBuffer(
    device: device,
    label: "\(transport.rawValue)-all-storage-output"
  )
  let denseOutput = try makeOutputBuffer(
    device: device,
    label: "\(transport.rawValue)-dense-poison-output"
  )

  try dispatch(
    encoder: encoder,
    output: canonicalOutput,
    table: canonical,
    transport: transport
  )
  try dispatch(
    encoder: encoder,
    output: reboundOutput,
    table: rebound,
    transport: transport
  )
  try dispatch(
    encoder: encoder,
    output: allStorageOutput,
    table: allStorageCompatibility,
    transport: transport
  )
  try dispatch(
    encoder: encoder,
    output: denseOutput,
    table: densePoison,
    transport: transport
  )
  encoder.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
  try require(
    commandBuffer.status == .completed && commandBuffer.error == nil,
    "\(transport.rawValue) compute failed: "
      + (commandBuffer.error?.localizedDescription ?? "unknown error")
  )

  return ComputeResults(
    canonical: readWords(canonicalOutput, count: 10),
    rebound: readWords(reboundOutput, count: 10),
    allStorageCompatibility: readWords(allStorageOutput, count: 10),
    densePoison: readWords(denseOutput, count: 10)
  )
}

func requireReflection(
  _ buffers: [ReflectedBuffer],
  indices: [Int],
  internalDataSize: Int,
  internalAlignment: Int,
  label: String
) throws {
  try require(
    buffers.map(\.index) == indices,
    "\(label) buffer indices drifted: \(buffers.map(\.index))"
  )
  guard let internalBuffer = buffers.first(where: { $0.index == 30 }) else {
    try fail("\(label) omitted immediate-data buffer(30)")
  }
  try require(
    internalBuffer.dataSize == internalDataSize,
    "\(label) internal dataSize is \(internalBuffer.dataSize), expected \(internalDataSize)"
  )
  try require(
    internalBuffer.alignment == internalAlignment,
    "\(label) internal alignment is \(internalBuffer.alignment), expected \(internalAlignment)"
  )
}

func run() throws {
  guard CommandLine.arguments.count == 7 else {
    try fail(
      "usage: runtime-canary <immediate-compute.metal> <immediate-vertex.metal> "
        + "<immediate-fragment.metal> <ubo-compute.metal> <ubo-vertex.metal> "
        + "<ubo-fragment.metal>"
    )
  }
  guard let device = MTLCreateSystemDefaultDevice() else {
    FileHandle.standardError.write(Data("SKIP:no-metal-device\n".utf8))
    exit(75)
  }

  let immediateCompute = try makeComputePipeline(
    device: device,
    path: CommandLine.arguments[1]
  )
  let immediateRender = try makeRenderPipeline(
    device: device,
    vertexPath: CommandLine.arguments[2],
    fragmentPath: CommandLine.arguments[3]
  )
  let uboCompute = try makeComputePipeline(
    device: device,
    path: CommandLine.arguments[4]
  )
  let uboRender = try makeRenderPipeline(
    device: device,
    vertexPath: CommandLine.arguments[5],
    fragmentPath: CommandLine.arguments[6]
  )

  try requireReflection(
    immediateCompute.buffers,
    indices: [0, 1, 2, 3, 4, 5, 30],
    internalDataSize: 28,
    internalAlignment: 4,
    label: "immediate compute"
  )
  try requireReflection(
    immediateRender.vertexBuffers,
    indices: [0, 29, 30],
    internalDataSize: 8,
    internalAlignment: 4,
    label: "immediate vertex"
  )
  try requireReflection(
    immediateRender.fragmentBuffers,
    indices: [5, 30],
    internalDataSize: 28,
    internalAlignment: 4,
    label: "immediate fragment"
  )
  try requireReflection(
    uboCompute.buffers,
    indices: [0, 1, 2, 3, 4, 5, 30],
    internalDataSize: 32,
    internalAlignment: 16,
    label: "UBO compute"
  )
  try requireReflection(
    uboRender.vertexBuffers,
    indices: [0, 29, 30],
    internalDataSize: 16,
    internalAlignment: 16,
    label: "UBO vertex"
  )
  try requireReflection(
    uboRender.fragmentBuffers,
    indices: [5, 30],
    internalDataSize: 32,
    internalAlignment: 16,
    label: "UBO fragment"
  )
  try require(
    immediateRender.vertexStreamIndex == 29 && uboRender.vertexStreamIndex == 29,
    "stage-local render pipeline did not consume vertex stream 29"
  )

  let immediateResults = try runComputeSuite(
    device: device,
    pipeline: immediateCompute.state,
    transport: .immediate
  )
  let uboResults = try runComputeSuite(
    device: device,
    pipeline: uboCompute.state,
    transport: .ubo
  )
  let expectedCanonical: [UInt32] = [2, 3, 4, 5, 6, 0, 0, 0, 0, 0]
  let expectedRebound: [UInt32] = [3, 4, 5, 6, 7, 0, 0, 0, 0, 0]
  let expectedDense: [UInt32] = [2, 3, 0, 28, 268_435_455, 0, 0, 0, 0, 0]
  try require(immediateResults == uboResults, "immediate and UBO readbacks differ")
  try require(
    immediateResults.canonical == expectedCanonical,
    "canonical range-byte table returned \(immediateResults.canonical)"
  )
  try require(
    immediateResults.rebound == expectedRebound,
    "second dispatch/rebind returned \(immediateResults.rebound)"
  )
  try require(
    immediateResults.allStorageCompatibility == expectedCanonical,
    "all-storage compatibility table changed the readback"
  )
  try require(
    immediateResults.densePoison == expectedDense,
    "dense semantic-order poison returned \(immediateResults.densePoison)"
  )

  let canonicalTable: [UInt32] = [32, 0, 32, 36, 20, 112, 0, 0]
  let reboundTable: [UInt32] = [48, 0, 40, 40, 24, 128, 0, 0]
  let allStorageTable: [UInt32] = [32, 40, 32, 36, 20, 112, 0, 0]
  let denseTable: [UInt32] = [32, 32, 36, 20, 112, 0, 0, 0]
  try emit([
    "allStorageCompatibilityResult": immediateResults.allStorageCompatibility,
    "backingBufferLength": 2_048,
    "backingBufferOffsets": [0, 256, 512, 768, 1_024],
    "canonicalResult": immediateResults.canonical,
    "densePoisonResult": immediateResults.densePoison,
    "device": device.name,
    "dispatchesPerTransport": 4,
    "exactCapacityVertexStreamIndex": immediateRender.vertexStreamIndex,
    "immediateAllStorageUploadBytesHex": bytesHex(
      try uploadWords(allStorageTable, transport: .immediate)
    ),
    "immediateCanonicalUploadBytesHex": bytesHex(
      try uploadWords(canonicalTable, transport: .immediate)
    ),
    "immediateComputeAlignment": 4,
    "immediateComputeDataSize": 28,
    "immediateDenseUploadBytesHex": bytesHex(
      try uploadWords(denseTable, transport: .immediate)
    ),
    "immediateFragmentAlignment": 4,
    "immediateFragmentDataSize": 28,
    "immediateReboundUploadBytesHex": bytesHex(
      try uploadWords(reboundTable, transport: .immediate)
    ),
    "immediateVertexAlignment": 4,
    "immediateVertexDataSize": 8,
    "reboundResult": immediateResults.rebound,
    "stageLocalFragmentBufferIndices": immediateRender.fragmentBuffers.map(\.index),
    "stageLocalVertexBufferIndices": immediateRender.vertexBuffers.map(\.index),
    "transportReadbacksEqual": true,
    "uboCanonicalUploadBytesHex": bytesHex(
      try uploadWords(canonicalTable, transport: .ubo)
    ),
    "uboComputeAlignment": 16,
    "uboComputeDataSize": 32,
    "uboFragmentAlignment": 16,
    "uboFragmentDataSize": 32,
    "uboVertexAlignment": 16,
    "uboVertexDataSize": 16,
  ])
}

do {
  try run()
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
