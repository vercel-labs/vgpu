import Foundation
import Metal

struct OverrideMetalProbeError: Error, CustomStringConvertible {
  let description: String
}

guard CommandLine.arguments.count == 4 else {
  throw OverrideMetalProbeError(
    description: "Usage: override-metal <metallib> <vertex> <fragment>"
  )
}

let libraryURL = URL(fileURLWithPath: CommandLine.arguments[1])
let vertexName = CommandLine.arguments[2]
let fragmentName = CommandLine.arguments[3]

guard let device = MTLCreateSystemDefaultDevice() else {
  throw OverrideMetalProbeError(description: "No default Metal device is available.")
}
let library = try device.makeLibrary(URL: libraryURL)
guard let vertexFunction = library.makeFunction(name: vertexName) else {
  throw OverrideMetalProbeError(description: "Missing vertex function \(vertexName).")
}
guard let fragmentFunction = library.makeFunction(name: fragmentName) else {
  throw OverrideMetalProbeError(description: "Missing fragment function \(fragmentName).")
}

let pipelineDescriptor = MTLRenderPipelineDescriptor()
pipelineDescriptor.vertexFunction = vertexFunction
pipelineDescriptor.fragmentFunction = fragmentFunction
pipelineDescriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
let pipeline = try device.makeRenderPipelineState(descriptor: pipelineDescriptor)

guard let queue = device.makeCommandQueue() else {
  throw OverrideMetalProbeError(description: "Failed to create a Metal command queue.")
}

func render() throws -> [UInt8] {
  let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm,
    width: 2,
    height: 2,
    mipmapped: false
  )
  textureDescriptor.storageMode = .private
  textureDescriptor.usage = [.renderTarget]
  guard
    let texture = device.makeTexture(descriptor: textureDescriptor),
    let readback = device.makeBuffer(length: 512, options: [.storageModeShared]),
    let commandBuffer = queue.makeCommandBuffer()
  else {
    throw OverrideMetalProbeError(description: "Failed to allocate Metal probe resources.")
  }

  let renderPass = MTLRenderPassDescriptor()
  renderPass.colorAttachments[0].texture = texture
  renderPass.colorAttachments[0].loadAction = .clear
  renderPass.colorAttachments[0].storeAction = .store
  renderPass.colorAttachments[0].clearColor = MTLClearColorMake(1, 0, 1, 1)
  guard let renderEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPass) else {
    throw OverrideMetalProbeError(description: "Failed to create a render encoder.")
  }
  renderEncoder.setRenderPipelineState(pipeline)
  renderEncoder.setViewport(
    MTLViewport(originX: 0, originY: 0, width: 2, height: 2, znear: 0, zfar: 1)
  )
  renderEncoder.setFrontFacing(.counterClockwise)
  renderEncoder.setCullMode(.none)
  renderEncoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  renderEncoder.endEncoding()

  guard let blitEncoder = commandBuffer.makeBlitCommandEncoder() else {
    throw OverrideMetalProbeError(description: "Failed to create a blit encoder.")
  }
  blitEncoder.copy(
    from: texture,
    sourceSlice: 0,
    sourceLevel: 0,
    sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
    sourceSize: MTLSize(width: 2, height: 2, depth: 1),
    to: readback,
    destinationOffset: 0,
    destinationBytesPerRow: 256,
    destinationBytesPerImage: 512
  )
  blitEncoder.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()

  guard commandBuffer.status == .completed else {
    throw OverrideMetalProbeError(
      description:
        "Metal command buffer failed: \(commandBuffer.error?.localizedDescription ?? "unknown error")"
    )
  }
  let bytes = readback.contents().bindMemory(to: UInt8.self, capacity: 512)
  return (0..<2).flatMap { row in
    (0..<2).flatMap { column in
      (0..<4).map { component in
        bytes[row * 256 + column * 4 + component]
      }
    }
  }
}

let expected: [UInt8] = [
  159, 96, 32, 96,
  223, 96, 32, 96,
  159, 159, 32, 96,
  223, 159, 32, 96,
]
let readbacks = [try render(), try render()]
guard readbacks.allSatisfy({ $0 == expected }) else {
  throw OverrideMetalProbeError(
    description: "Unexpected baked-override readback: \(readbacks)"
  )
}

let report: [String: Any] = [
  "device": device.name,
  "readbacks": readbacks,
]
let reportData = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
guard let reportJSON = String(data: reportData, encoding: .utf8) else {
  throw OverrideMetalProbeError(description: "Failed to encode the Metal probe report.")
}
print(reportJSON)
