import Darwin
import Foundation
import Metal

struct SpikeFailure: Error, CustomStringConvertible {
  let description: String
}

struct ReflectedBuffer: Equatable {
  let index: Int
  let isArgument: Bool
}

struct ExactImmediateData {
  let ordinaryValue: Float
  let storageBufferSizes: UInt32
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

func argumentIndex(_ position: Int, _ name: String) throws -> Int {
  guard let value = Int(CommandLine.arguments[position]), value >= 0 else {
    try fail("\(name) must be a non-negative integer")
  }
  return value
}

func compileLibrary(device: MTLDevice, path: String) throws -> MTLLibrary {
  let source = try String(contentsOfFile: path, encoding: .utf8)
  let options = MTLCompileOptions()
  options.languageVersion = .version2_4
  return try device.makeLibrary(source: source, options: options)
}

func makeVertexDescriptor(
  _ entries: [(attribute: Int, buffer: Int, format: MTLVertexFormat, stride: Int)]
) -> MTLVertexDescriptor {
  let descriptor = MTLVertexDescriptor()
  for entry in entries {
    descriptor.attributes[entry.attribute].format = entry.format
    descriptor.attributes[entry.attribute].offset = 0
    descriptor.attributes[entry.attribute].bufferIndex = entry.buffer
    descriptor.layouts[entry.buffer].stride = entry.stride
    descriptor.layouts[entry.buffer].stepFunction = .perVertex
    descriptor.layouts[entry.buffer].stepRate = 1
  }
  return descriptor
}

func makePipeline(
  device: MTLDevice,
  library: MTLLibrary,
  vertexName: String,
  fragmentName: String,
  vertexDescriptor: MTLVertexDescriptor
) throws -> (state: MTLRenderPipelineState, reflection: MTLRenderPipelineReflection) {
  guard let vertexFunction = library.makeFunction(name: vertexName) else {
    try fail("missing vertex function \(vertexName)")
  }
  guard let fragmentFunction = library.makeFunction(name: fragmentName) else {
    try fail("missing fragment function \(fragmentName)")
  }
  let descriptor = MTLRenderPipelineDescriptor()
  descriptor.vertexFunction = vertexFunction
  descriptor.fragmentFunction = fragmentFunction
  descriptor.vertexDescriptor = vertexDescriptor
  descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
  var reflection: MTLRenderPipelineReflection?
  let state = try device.makeRenderPipelineState(
    descriptor: descriptor,
    options: .bindingInfo,
    reflection: &reflection
  )
  guard let reflection else {
    try fail("pipeline \(vertexName) returned no binding reflection")
  }
  return (state, reflection)
}

func reflectedBuffers(_ reflection: MTLRenderPipelineReflection) -> [ReflectedBuffer] {
  return reflection.vertexBindings
    .filter { $0.type == .buffer && $0.isUsed }
    .map {
      ReflectedBuffer(index: Int($0.index), isArgument: $0.isArgument)
    }
    .sorted {
      if $0.index != $1.index { return $0.index < $1.index }
      return !$0.isArgument && $1.isArgument
    }
}

func makeBuffer<T>(device: MTLDevice, values: [T], label: String) throws -> MTLBuffer {
  guard !values.isEmpty else {
    try fail("cannot create empty buffer \(label)")
  }
  let buffer = values.withUnsafeBytes { bytes in
    device.makeBuffer(
      bytes: bytes.baseAddress!,
      length: bytes.count,
      options: .storageModeShared
    )
  }
  guard let buffer else {
    try fail("could not create buffer \(label)")
  }
  buffer.label = label
  return buffer
}

func makeRenderTarget(device: MTLDevice, width: Int, height: Int) throws -> MTLTexture {
  let descriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm,
    width: width,
    height: height,
    mipmapped: false
  )
  descriptor.storageMode = .private
  descriptor.usage = [.renderTarget]
  guard let texture = device.makeTexture(descriptor: descriptor) else {
    try fail("could not create render target")
  }
  return texture
}

func makeRenderPass(texture: MTLTexture) -> MTLRenderPassDescriptor {
  let pass = MTLRenderPassDescriptor()
  pass.colorAttachments[0].texture = texture
  pass.colorAttachments[0].loadAction = .clear
  pass.colorAttachments[0].storeAction = .store
  pass.colorAttachments[0].clearColor = MTLClearColorMake(1, 0, 1, 1)
  return pass
}

func finishAndRead(
  device: MTLDevice,
  commandBuffer: MTLCommandBuffer,
  texture: MTLTexture,
  width: Int,
  height: Int
) throws -> [[UInt8]] {
  let bytesPerRow = 256
  guard
    let readback = device.makeBuffer(
      length: bytesPerRow * height,
      options: .storageModeShared
    )
  else {
    try fail("could not create readback buffer")
  }
  guard let blit = commandBuffer.makeBlitCommandEncoder() else {
    try fail("could not create blit encoder")
  }
  blit.copy(
    from: texture,
    sourceSlice: 0,
    sourceLevel: 0,
    sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
    sourceSize: MTLSize(width: width, height: height, depth: 1),
    to: readback,
    destinationOffset: 0,
    destinationBytesPerRow: bytesPerRow,
    destinationBytesPerImage: bytesPerRow * height
  )
  blit.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
  try require(
    commandBuffer.status == .completed && commandBuffer.error == nil,
    "render did not complete: \(commandBuffer.error?.localizedDescription ?? "unknown error")"
  )

  let bytes = readback.contents().bindMemory(
    to: UInt8.self,
    capacity: bytesPerRow * height
  )
  var pixels: [[UInt8]] = []
  for y in 0..<height {
    for x in 0..<width {
      let offset = y * bytesPerRow + x * 4
      pixels.append(Array(UnsafeBufferPointer(start: bytes + offset, count: 4)))
    }
  }
  return pixels
}

func requirePixels(
  _ actual: [[UInt8]],
  _ expected: [[Int]],
  tolerance: Int,
  label: String
) throws {
  try require(actual.count == expected.count, "\(label) pixel count drifted")
  for (pixelIndex, pair) in zip(actual, expected).enumerated() {
    try require(
      pair.0.count == pair.1.count
        && zip(pair.0, pair.1).allSatisfy {
          abs(Int($0.0) - $0.1) <= tolerance
        },
      "\(label) pixel \(pixelIndex) returned \(pair.0), expected \(pair.1)"
    )
  }
}

func renderCollision(
  device: MTLDevice,
  pipeline: MTLRenderPipelineState,
  duplicateIndex: Int
) throws -> [[UInt8]] {
  let texture = try makeRenderTarget(device: device, width: 2, height: 1)
  let first = try makeBuffer(
    device: device,
    values: [Float](repeating: 0.125, count: 3),
    label: "collision-first"
  )
  let second = try makeBuffer(
    device: device,
    values: [Float](repeating: 0.375, count: 3),
    label: "collision-second"
  )
  guard let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer(),
    let encoder = commandBuffer.makeRenderCommandEncoder(
      descriptor: makeRenderPass(texture: texture)
    )
  else {
    try fail("could not create collision command encoder")
  }
  encoder.setRenderPipelineState(pipeline)
  encoder.setScissorRect(MTLScissorRect(x: 0, y: 0, width: 1, height: 1))
  encoder.setVertexBuffer(first, offset: 0, index: duplicateIndex)
  encoder.setVertexBuffer(second, offset: 0, index: duplicateIndex)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.setScissorRect(MTLScissorRect(x: 1, y: 0, width: 1, height: 1))
  encoder.setVertexBuffer(second, offset: 0, index: duplicateIndex)
  encoder.setVertexBuffer(first, offset: 0, index: duplicateIndex)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.endEncoding()
  let pixels = try finishAndRead(
    device: device,
    commandBuffer: commandBuffer,
    texture: texture,
    width: 2,
    height: 1
  )
  try requirePixels(
    pixels,
    [[191, 191, 191, 255], [64, 64, 64, 255]],
    tolerance: 1,
    label: "collision binding order"
  )
  return pixels
}

func renderPipelineSwitch(
  device: MTLDevice,
  pipelineA: MTLRenderPipelineState,
  pipelineB: MTLRenderPipelineState,
  streamA: Int,
  streamB: Int
) throws -> [[UInt8]] {
  let texture = try makeRenderTarget(device: device, width: 5, height: 1)
  let white = try makeBuffer(
    device: device,
    values: [SIMD4<Float>](repeating: SIMD4(1, 1, 1, 1), count: 3),
    label: "switch-white"
  )
  let green = try makeBuffer(
    device: device,
    values: [SIMD4<Float>](repeating: SIMD4(0, 1, 0, 1), count: 3),
    label: "switch-green"
  )
  let red = try makeBuffer(
    device: device,
    values: [SIMD4<Float>](repeating: SIMD4(1, 0, 0, 1), count: 3),
    label: "switch-red-poison"
  )
  guard let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer(),
    let encoder = commandBuffer.makeRenderCommandEncoder(
      descriptor: makeRenderPass(texture: texture)
    )
  else {
    try fail("could not create pipeline-switch command encoder")
  }

  encoder.setVertexBuffer(white, offset: 0, index: 0)
  encoder.setVertexBuffer(green, offset: 0, index: streamA)
  encoder.setVertexBuffer(red, offset: 0, index: streamB)

  encoder.setRenderPipelineState(pipelineA)
  encoder.setScissorRect(MTLScissorRect(x: 0, y: 0, width: 1, height: 1))
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

  encoder.setRenderPipelineState(pipelineB)
  encoder.setScissorRect(MTLScissorRect(x: 1, y: 0, width: 1, height: 1))
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

  encoder.setVertexBuffer(white, offset: 0, index: streamA)
  encoder.setVertexBuffer(green, offset: 0, index: streamB)
  encoder.setScissorRect(MTLScissorRect(x: 2, y: 0, width: 1, height: 1))
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

  encoder.setRenderPipelineState(pipelineA)
  encoder.setScissorRect(MTLScissorRect(x: 3, y: 0, width: 1, height: 1))
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

  encoder.setVertexBuffer(green, offset: 0, index: streamA)
  encoder.setScissorRect(MTLScissorRect(x: 4, y: 0, width: 1, height: 1))
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.endEncoding()

  let pixels = try finishAndRead(
    device: device,
    commandBuffer: commandBuffer,
    texture: texture,
    width: 5,
    height: 1
  )
  try requirePixels(
    pixels,
    [
      [0, 255, 0, 255],
      [0, 0, 0, 255],
      [0, 255, 0, 255],
      [255, 255, 255, 255],
      [0, 255, 0, 255],
    ],
    tolerance: 0,
    label: "pipeline switch"
  )
  return pixels
}

func renderExactCapacity(
  device: MTLDevice,
  pipeline: MTLRenderPipelineState,
  exactStreamStart: Int,
  immediateIndex: Int
) throws -> [UInt8] {
  let texture = try makeRenderTarget(device: device, width: 1, height: 1)
  guard let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer(),
    let encoder = commandBuffer.makeRenderCommandEncoder(
      descriptor: makeRenderPass(texture: texture)
    )
  else {
    try fail("could not create exact-capacity command encoder")
  }
  encoder.setRenderPipelineState(pipeline)
  var retainedBuffers: [MTLBuffer] = []

  func bindScalar(_ value: Float, index: Int, label: String) throws {
    let buffer = try makeBuffer(device: device, values: [value], label: label)
    retainedBuffers.append(buffer)
    encoder.setVertexBuffer(buffer, offset: 0, index: index)
  }

  for index in 0..<12 {
    try bindScalar(0.015625, index: index, label: "exact-constant-\(index)")
  }
  for index in 12..<22 {
    let value: Float = index >= 20 ? 0.125 : 0.0625
    try bindScalar(value, index: index, label: "exact-device-\(index)")
  }
  for stream in 0..<8 {
    let buffer = try makeBuffer(
      device: device,
      values: [Float](repeating: 0.0625, count: 3),
      label: "exact-stream-\(stream)"
    )
    retainedBuffers.append(buffer)
    encoder.setVertexBuffer(buffer, offset: 0, index: exactStreamStart + stream)
  }
  let immediateData = try makeBuffer(
    device: device,
    values: [
      ExactImmediateData(
        ordinaryValue: 0.03125,
        storageBufferSizes: 8
      )
    ],
    label: "exact-immediate-data"
  )
  retainedBuffers.append(immediateData)
  encoder.setVertexBuffer(immediateData, offset: 0, index: immediateIndex)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.endEncoding()

  let pixels = try finishAndRead(
    device: device,
    commandBuffer: commandBuffer,
    texture: texture,
    width: 1,
    height: 1
  )
  _ = retainedBuffers.count
  let expected = [[128, 64, 191, 255]]
  try requirePixels(
    pixels,
    expected,
    tolerance: 1,
    label: "exact capacity"
  )
  return pixels[0]
}

func run() throws {
  guard CommandLine.arguments.count == 8 else {
    try fail(
      "usage: c1-vertex-buffer-slots <collision.metal> <partition.metal> "
        + "<exact-capacity.metal> <switch-a-stream> <switch-b-stream> "
        + "<exact-stream-start> <immediate-index>"
    )
  }
  let switchAStream = try argumentIndex(4, "switch-a-stream")
  let switchBStream = try argumentIndex(5, "switch-b-stream")
  let exactStreamStart = try argumentIndex(6, "exact-stream-start")
  let immediateIndex = try argumentIndex(7, "immediate-index")
  guard let device = MTLCreateSystemDefaultDevice() else {
    try emit([
      "schemaVersion": 1,
      "status": "skipped",
      "reason": "no-metal-device",
    ])
    return
  }

  let collisionLibrary = try compileLibrary(
    device: device,
    path: CommandLine.arguments[1]
  )
  let collisionDescriptor = makeVertexDescriptor([
    (attribute: 0, buffer: 0, format: .float, stride: 4)
  ])
  let collision = try makePipeline(
    device: device,
    library: collisionLibrary,
    vertexName: "collisionVertex",
    fragmentName: "collisionFragment",
    vertexDescriptor: collisionDescriptor
  )
  let collisionBindings = reflectedBuffers(collision.reflection)
  let collisionAtZero = collisionBindings.filter { $0.index == 0 }
  try require(
    collisionBindings.count == 2
      && collisionAtZero == [
        ReflectedBuffer(index: 0, isArgument: false),
        ReflectedBuffer(index: 0, isArgument: true),
      ],
    "colliding pipeline reflection did not expose both buffer-index-0 bindings: \(collisionBindings)"
  )
  let collisionPixels = try renderCollision(
    device: device,
    pipeline: collision.state,
    duplicateIndex: 0
  )

  let switchLibrary = try compileLibrary(
    device: device,
    path: CommandLine.arguments[2]
  )
  let switchADescriptor = makeVertexDescriptor([
    (attribute: 0, buffer: switchAStream, format: .float4, stride: 16)
  ])
  let switchA = try makePipeline(
    device: device,
    library: switchLibrary,
    vertexName: "switchA",
    fragmentName: "switchFragment",
    vertexDescriptor: switchADescriptor
  )
  let switchBDescriptor = makeVertexDescriptor([
    (attribute: 0, buffer: switchBStream, format: .float4, stride: 16)
  ])
  let switchB = try makePipeline(
    device: device,
    library: switchLibrary,
    vertexName: "switchB",
    fragmentName: "switchFragment",
    vertexDescriptor: switchBDescriptor
  )
  let switchABindings = reflectedBuffers(switchA.reflection)
  let switchBBindings = reflectedBuffers(switchB.reflection)
  try require(
    switchABindings == [
      ReflectedBuffer(index: 0, isArgument: true),
      ReflectedBuffer(index: switchAStream, isArgument: false),
    ],
    "SwitchA reflection drifted: \(switchABindings)"
  )
  try require(
    switchBBindings == [
      ReflectedBuffer(index: 0, isArgument: true),
      ReflectedBuffer(index: 1, isArgument: true),
      ReflectedBuffer(index: switchBStream, isArgument: false),
    ],
    "SwitchB reflection drifted: \(switchBBindings)"
  )
  let switchPixels = try renderPipelineSwitch(
    device: device,
    pipelineA: switchA.state,
    pipelineB: switchB.state,
    streamA: switchAStream,
    streamB: switchBStream
  )

  let exactLibrary = try compileLibrary(
    device: device,
    path: CommandLine.arguments[3]
  )
  let exactDescriptor = makeVertexDescriptor(
    (0..<8).map {
      (attribute: $0, buffer: exactStreamStart + $0, format: .float, stride: 4)
    }
  )
  let exact = try makePipeline(
    device: device,
    library: exactLibrary,
    vertexName: "exactCapacityVertex",
    fragmentName: "exactCapacityFragment",
    vertexDescriptor: exactDescriptor
  )
  let exactBindings = reflectedBuffers(exact.reflection)
  let expectedArgumentIndices = Array(0...21) + [immediateIndex]
  let expectedVertexIndices = Array(exactStreamStart..<(exactStreamStart + 8))
  try require(
    exactBindings.filter(\.isArgument).map(\.index) == expectedArgumentIndices
      && exactBindings.filter { !$0.isArgument }.map(\.index) == expectedVertexIndices
      && exactBindings.count == 31 && Set(exactBindings.map(\.index)).count == 31,
    "exact-capacity pipeline reflection drifted: \(exactBindings)"
  )
  let ordinaryValueByteOffset = MemoryLayout<ExactImmediateData>.offset(
    of: \ExactImmediateData.ordinaryValue
  )
  let sizeTableByteOffset = MemoryLayout<ExactImmediateData>.offset(
    of: \ExactImmediateData.storageBufferSizes
  )
  try require(
    ordinaryValueByteOffset == 0 && sizeTableByteOffset == 4
      && MemoryLayout<ExactImmediateData>.size == 8
      && MemoryLayout<ExactImmediateData>.stride == 8,
    "immediate-data host layout drifted"
  )
  let exactPixel = try renderExactCapacity(
    device: device,
    pipeline: exact.state,
    exactStreamStart: exactStreamStart,
    immediateIndex: immediateIndex
  )

  try emit([
    "schemaVersion": 1,
    "status": "passed",
    "languageVersion": "2.4",
    "collision": [
      "pipelineCreation": "passed",
      "duplicateIndex": 0,
      "usedBufferBindingCount": collisionBindings.count,
      "isArgument": collisionAtZero.map(\.isArgument),
      "sharedNamespace": true,
      "lastBoundSamples": collisionPixels,
      "expectedLastBoundSamples": [
        [191, 191, 191, 255],
        [64, 64, 64, 255],
      ],
      "tolerance": 1,
    ],
    "candidate": [
      "pipelineCreation": "passed",
      "exactCapacity": [
        "shaderIndices": Array(0...21),
        "vertexStreamIndices": expectedVertexIndices,
        "internalIndices": [immediateIndex],
        "usedBufferBindingCount": exactBindings.count,
        "uniqueBufferIndexCount": Set(exactBindings.map(\.index)).count,
        "immediateData": [
          "index": immediateIndex,
          "ordinaryValue": 0.03125,
          "storageBufferSizeSentinel": 8,
          "ordinaryValueByteOffset": ordinaryValueByteOffset!,
          "sizeTableByteOffset": sizeTableByteOffset!,
          "byteLength": MemoryLayout<ExactImmediateData>.size,
        ],
        "renderSample": exactPixel,
        "renderExpected": [128, 64, 191, 255],
        "renderTolerance": 1,
      ],
      "pipelineSwitch": [
        "streamIndices": [switchAStream, switchBStream],
        "switchABindings": switchABindings.map {
          ["index": $0.index, "isArgument": $0.isArgument]
        },
        "switchBBindings": switchBBindings.map {
          ["index": $0.index, "isArgument": $0.isArgument]
        },
        "samples": switchPixels,
        "expectedSamples": [
          [0, 255, 0, 255],
          [0, 0, 0, 255],
          [0, 255, 0, 255],
          [255, 255, 255, 255],
          [0, 255, 0, 255],
        ],
        "tolerance": 0,
      ],
    ],
  ])
}

do {
  try run()
} catch {
  let message = "C1 vertex buffer slots: \(error)\n"
  FileHandle.standardError.write(Data(message.utf8))
  exit(1)
}
