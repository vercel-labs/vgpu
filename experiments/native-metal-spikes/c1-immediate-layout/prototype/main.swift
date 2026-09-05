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

struct RenderSample {
  let color: [UInt32]
  let depthBits: UInt32
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
    try fail("could not encode runtime result as UTF-8")
  }
  print(string)
}

func compileLibrary(device: MTLDevice, path: String) throws -> MTLLibrary {
  let source = try String(contentsOfFile: path, encoding: .utf8)
  let options = MTLCompileOptions()
  options.languageVersion = .version2_4
  return try device.makeLibrary(source: source, options: options)
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

func requireReflection(
  _ buffers: [ReflectedBuffer],
  indices: [Int],
  immediateDataSize: Int,
  label: String
) throws {
  try require(
    buffers.map(\.index) == indices,
    "\(label) buffer indices drifted: \(buffers.map(\.index))"
  )
  guard let immediate = buffers.first(where: { $0.index == 30 }) else {
    try fail("\(label) omitted immediate buffer(30)")
  }
  try require(
    immediate.dataSize == immediateDataSize,
    "\(label) immediate dataSize is \(immediate.dataSize), expected \(immediateDataSize)"
  )
  try require(
    immediate.alignment == 4,
    "\(label) immediate alignment is \(immediate.alignment), expected 4"
  )
}

func littleEndianHex(_ words: [UInt32]) -> String {
  words
    .flatMap { word -> [UInt8] in
      var value = word.littleEndian
      return withUnsafeBytes(of: &value) { Array($0) }
    }
    .map { String(format: "%02x", $0) }
    .joined()
}

func setVertexImmediates(
  encoder: MTLRenderCommandEncoder,
  rangeBytes: UInt32
) {
  let words = [UInt32(0), rangeBytes].map(\.littleEndian)
  words.withUnsafeBytes { bytes in
    encoder.setVertexBytes(bytes.baseAddress!, length: bytes.count, index: 30)
  }
}

func setFragmentImmediates(
  encoder: MTLRenderCommandEncoder,
  depthMin: Float,
  depthMax: Float,
  rangeBytes: UInt32
) {
  let words = [
    UInt32(0),
    depthMin.bitPattern,
    depthMax.bitPattern,
    rangeBytes,
  ].map(\.littleEndian)
  words.withUnsafeBytes { bytes in
    encoder.setFragmentBytes(bytes.baseAddress!, length: bytes.count, index: 30)
  }
}

func render(
  device: MTLDevice,
  queue: MTLCommandQueue,
  pipeline: MTLRenderPipelineState,
  depthState: MTLDepthStencilState,
  backing: MTLBuffer,
  backingOffset: Int,
  rangeBytes: UInt32,
  depthMin: Float,
  depthMax: Float
) throws -> RenderSample {
  let colorDescriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba32Uint,
    width: 1,
    height: 1,
    mipmapped: false
  )
  colorDescriptor.storageMode = .private
  colorDescriptor.usage = [.renderTarget]
  let depthDescriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .depth32Float,
    width: 1,
    height: 1,
    mipmapped: false
  )
  depthDescriptor.storageMode = .private
  depthDescriptor.usage = [.renderTarget]
  guard
    let color = device.makeTexture(descriptor: colorDescriptor),
    let depth = device.makeTexture(descriptor: depthDescriptor),
    let readback = device.makeBuffer(length: 512, options: .storageModeShared),
    let commandBuffer = queue.makeCommandBuffer()
  else {
    try fail("could not allocate render/readback resources")
  }

  memset(readback.contents(), 0xff, readback.length)
  let renderPass = MTLRenderPassDescriptor()
  renderPass.colorAttachments[0].texture = color
  renderPass.colorAttachments[0].loadAction = .clear
  renderPass.colorAttachments[0].storeAction = .store
  renderPass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
  renderPass.depthAttachment.texture = depth
  renderPass.depthAttachment.loadAction = .clear
  renderPass.depthAttachment.storeAction = .store
  renderPass.depthAttachment.clearDepth = 1

  guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPass) else {
    try fail("could not create render encoder")
  }
  encoder.setRenderPipelineState(pipeline)
  encoder.setDepthStencilState(depthState)
  encoder.setViewport(
    MTLViewport(originX: 0, originY: 0, width: 1, height: 1, znear: 0, zfar: 1)
  )
  encoder.setCullMode(.none)
  encoder.setVertexBuffer(backing, offset: backingOffset, index: 0)
  encoder.setFragmentBuffer(backing, offset: backingOffset, index: 0)
  setVertexImmediates(encoder: encoder, rangeBytes: rangeBytes)
  setFragmentImmediates(
    encoder: encoder,
    depthMin: depthMin,
    depthMax: depthMax,
    rangeBytes: rangeBytes
  )
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.endEncoding()

  guard let blit = commandBuffer.makeBlitCommandEncoder() else {
    try fail("could not create readback blit encoder")
  }
  blit.copy(
    from: color,
    sourceSlice: 0,
    sourceLevel: 0,
    sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
    sourceSize: MTLSize(width: 1, height: 1, depth: 1),
    to: readback,
    destinationOffset: 0,
    destinationBytesPerRow: 256,
    destinationBytesPerImage: 256
  )
  blit.copy(
    from: depth,
    sourceSlice: 0,
    sourceLevel: 0,
    sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
    sourceSize: MTLSize(width: 1, height: 1, depth: 1),
    to: readback,
    destinationOffset: 256,
    destinationBytesPerRow: 256,
    destinationBytesPerImage: 256
  )
  blit.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
  try require(
    commandBuffer.status == .completed && commandBuffer.error == nil,
    "Metal render failed: \(commandBuffer.error?.localizedDescription ?? "unknown error")"
  )

  let colorWords = readback.contents().bindMemory(to: UInt32.self, capacity: 4)
  let depthBits = readback.contents().advanced(by: 256).load(as: UInt32.self)
  return RenderSample(
    color: (0..<4).map { UInt32(littleEndian: colorWords[$0]) },
    depthBits: UInt32(littleEndian: depthBits)
  )
}

func run() throws {
  guard CommandLine.arguments.count == 5 else {
    try fail(
      "usage: immediate-layout-canary <compute.metal> <vertex.metal> "
        + "<fragment-depth.metal> <fragment-no-depth.metal>"
    )
  }
  guard let device = MTLCreateSystemDefaultDevice() else {
    FileHandle.standardError.write(Data("SKIP:no-metal-device\n".utf8))
    exit(75)
  }
  guard let queue = device.makeCommandQueue() else {
    try fail("could not create Metal command queue")
  }

  let computeLibrary = try compileLibrary(device: device, path: CommandLine.arguments[1])
  let vertexLibrary = try compileLibrary(device: device, path: CommandLine.arguments[2])
  let depthLibrary = try compileLibrary(device: device, path: CommandLine.arguments[3])
  let noDepthLibrary = try compileLibrary(device: device, path: CommandLine.arguments[4])
  guard
    let computeFunction = computeLibrary.makeFunction(name: "vgpu_layout_compute"),
    let vertexFunction = vertexLibrary.makeFunction(name: "vgpu_layout_vertex"),
    let depthFunction = depthLibrary.makeFunction(name: "vgpu_layout_fragment_depth"),
    let noDepthFunction = noDepthLibrary.makeFunction(name: "vgpu_layout_fragment_no_depth")
  else {
    try fail("generated libraries omitted one or more remapped entry points")
  }

  var computeReflection: MTLComputePipelineReflection?
  _ = try device.makeComputePipelineState(
    function: computeFunction,
    options: .bindingInfo,
    reflection: &computeReflection
  )
  guard let computeReflection else {
    try fail("compute pipeline returned no binding reflection")
  }
  let computeBuffers = reflectedBuffers(computeReflection.bindings)
  try requireReflection(
    computeBuffers,
    indices: [0, 1, 30],
    immediateDataSize: 8,
    label: "compute"
  )

  func makeRenderPipeline(
    fragmentFunction: MTLFunction,
    writesDepth: Bool
  ) throws -> (MTLRenderPipelineState, MTLRenderPipelineReflection) {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = vertexFunction
    descriptor.fragmentFunction = fragmentFunction
    descriptor.colorAttachments[0].pixelFormat = .rgba32Uint
    if writesDepth {
      descriptor.depthAttachmentPixelFormat = .depth32Float
    }
    var reflection: MTLRenderPipelineReflection?
    let state = try device.makeRenderPipelineState(
      descriptor: descriptor,
      options: .bindingInfo,
      reflection: &reflection
    )
    guard let reflection else {
      try fail("render pipeline returned no binding reflection")
    }
    return (state, reflection)
  }

  let (depthPipeline, depthReflection) = try makeRenderPipeline(
    fragmentFunction: depthFunction,
    writesDepth: true
  )
  let (_, noDepthReflection) = try makeRenderPipeline(
    fragmentFunction: noDepthFunction,
    writesDepth: false
  )
  let vertexBuffers = reflectedBuffers(depthReflection.vertexBindings)
  let depthFragmentBuffers = reflectedBuffers(depthReflection.fragmentBindings)
  let noDepthFragmentBuffers = reflectedBuffers(noDepthReflection.fragmentBindings)
  try requireReflection(
    vertexBuffers,
    indices: [0, 30],
    immediateDataSize: 8,
    label: "vertex"
  )
  try requireReflection(
    depthFragmentBuffers,
    indices: [0, 30],
    immediateDataSize: 16,
    label: "fragment-depth"
  )
  try requireReflection(
    noDepthFragmentBuffers,
    indices: [0, 30],
    immediateDataSize: 16,
    label: "fragment-no-depth"
  )

  let depthDescriptor = MTLDepthStencilDescriptor()
  depthDescriptor.depthCompareFunction = .always
  depthDescriptor.isDepthWriteEnabled = true
  guard
    let depthState = device.makeDepthStencilState(descriptor: depthDescriptor),
    let backing = device.makeBuffer(length: 512, options: .storageModeShared)
  else {
    try fail("could not allocate live render resources")
  }
  memset(backing.contents(), 0, backing.length)
  backing.contents().storeBytes(of: UInt32(11).littleEndian, as: UInt32.self)
  backing.contents().advanced(by: 256).storeBytes(
    of: UInt32(22).littleEndian,
    as: UInt32.self
  )

  let canonicalMin = Float(0.2)
  let canonicalMax = Float(0.6)
  let reboundMin = Float(0.1)
  let reboundMax = Float(0.4)
  let canonical = try render(
    device: device,
    queue: queue,
    pipeline: depthPipeline,
    depthState: depthState,
    backing: backing,
    backingOffset: 0,
    rangeBytes: 16,
    depthMin: canonicalMin,
    depthMax: canonicalMax
  )
  let rebound = try render(
    device: device,
    queue: queue,
    pipeline: depthPipeline,
    depthState: depthState,
    backing: backing,
    backingOffset: 256,
    rangeBytes: 28,
    depthMin: reboundMin,
    depthMax: reboundMax
  )
  try require(
    canonical.color == [4, 4, 11, 11],
    "canonical arrayLength/value readback drifted: \(canonical.color)"
  )
  try require(
    rebound.color == [7, 7, 22, 22],
    "rebound arrayLength/value readback drifted: \(rebound.color)"
  )
  try require(
    canonical.depthBits == canonicalMax.bitPattern,
    "canonical fragment depth was not clamped to max"
  )
  try require(
    rebound.depthBits == reboundMax.bitPattern,
    "rebound fragment depth was not clamped to max"
  )

  let canonicalVertexUpload: [UInt32] = [0, 16]
  let reboundVertexUpload: [UInt32] = [0, 28]
  let canonicalFragmentUpload: [UInt32] = [
    0, canonicalMin.bitPattern, canonicalMax.bitPattern, 16,
  ]
  let reboundFragmentUpload: [UInt32] = [
    0, reboundMin.bitPattern, reboundMax.bitPattern, 28,
  ]
  try emit([
    "backingBufferLength": backing.length,
    "backingOffsets": [0, 256],
    "canonicalColor": canonical.color,
    "canonicalDepthBits": canonical.depthBits,
    "canonicalFragmentUploadHex": littleEndianHex(canonicalFragmentUpload),
    "canonicalVertexUploadHex": littleEndianHex(canonicalVertexUpload),
    "computeImmediateAlignment": computeBuffers.first(where: { $0.index == 30 })!.alignment,
    "computeImmediateDataSize": computeBuffers.first(where: { $0.index == 30 })!.dataSize,
    "device": device.name,
    "fragmentDepthImmediateAlignment": depthFragmentBuffers.first(where: { $0.index == 30 })!
      .alignment,
    "fragmentDepthImmediateDataSize": depthFragmentBuffers.first(where: { $0.index == 30 })!
      .dataSize,
    "fragmentNoDepthImmediateAlignment": noDepthFragmentBuffers.first(where: { $0.index == 30 })!
      .alignment,
    "fragmentNoDepthImmediateDataSize": noDepthFragmentBuffers.first(where: { $0.index == 30 })!
      .dataSize,
    "reboundColor": rebound.color,
    "reboundDepthBits": rebound.depthBits,
    "reboundFragmentUploadHex": littleEndianHex(reboundFragmentUpload),
    "reboundVertexUploadHex": littleEndianHex(reboundVertexUpload),
    "vertexImmediateAlignment": vertexBuffers.first(where: { $0.index == 30 })!.alignment,
    "vertexImmediateDataSize": vertexBuffers.first(where: { $0.index == 30 })!.dataSize,
  ])
}

do {
  try run()
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
