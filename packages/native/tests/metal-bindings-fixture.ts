import type { MetalPackageInput } from "../src/index.ts";

// Handwritten MSL isolates generated bindings. This is not compiler integration.
export const bindingMSL = `#include <metal_stdlib>
using namespace metal;
struct VertexInput { float2 position [[attribute(0)]]; };
vertex float4 vertex_main(VertexInput input [[stage_in]], constant float4& params [[buffer(5)]]) {
  return float4(input.position * params.w, 0.0, 1.0);
}
fragment float4 fragment_main(constant float4& params [[buffer(3)]]) {
  return params;
}
`;

export function bindingPackageInput(
  library: Uint8Array = new Uint8Array([1, 2, 3])
): MetalPackageInput {
  return {
    moduleName: "AppShaders",
    library,
    programs: [
      {
        name: "Gradient",
        functions: { vertex: "vertex_main", fragment: "fragment_main" },
        uniforms: [
          {
            name: "params",
            typeName: "Params",
            byteCount: 16,
            alignment: 16,
            members: [{ name: "color", type: "vec4f", offset: 0 }],
            slots: [
              { stage: "vertex", index: 5 },
              { stage: "fragment", index: 3 },
            ],
          },
        ],
      },
    ],
  };
}

export const renderSetup = `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice(), device.supportsFamily(.apple1) else {
  fatalError("Apple GPU required for this native binding gate")
}
let gradient = try Gradient.load(device: device)
let vertexDescriptor = MTLVertexDescriptor()
vertexDescriptor.attributes[0].format = .float2
vertexDescriptor.attributes[0].bufferIndex = 7
vertexDescriptor.layouts[7].stride = 8
let descriptor = MTLRenderPipelineDescriptor()
descriptor.vertexFunction = gradient.vertex
descriptor.fragmentFunction = gradient.fragment
descriptor.vertexDescriptor = vertexDescriptor
descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
let positions: [Float] = [-1, -1, 3, -1, -1, 3]
let vertices = positions.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared)! }
let queue = device.makeCommandQueue()!
@MainActor func render(_ encode: (any MTLRenderCommandEncoder) throws -> Void) throws -> [UInt8] {
  let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 4, height: 4, mipmapped: false)
  textureDescriptor.storageMode = .private
  textureDescriptor.usage = .renderTarget
  let texture = device.makeTexture(descriptor: textureDescriptor)!
  let readback = device.makeBuffer(length: 1024, options: .storageModeShared)!
  let command = queue.makeCommandBuffer()!
  let pass = MTLRenderPassDescriptor()
  pass.colorAttachments[0].texture = texture
  pass.colorAttachments[0].loadAction = .clear
  pass.colorAttachments[0].storeAction = .store
  pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 1, alpha: 1)
  let encoder = command.makeRenderCommandEncoder(descriptor: pass)!
  encoder.setRenderPipelineState(pipeline)
  encoder.setVertexBuffer(vertices, offset: 0, index: 7)
  try encode(encoder)
  encoder.endEncoding()
  let blit = command.makeBlitCommandEncoder()!
  blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: 4, height: 4, depth: 1), to: readback, destinationOffset: 0, destinationBytesPerRow: 256, destinationBytesPerImage: 1024)
  blit.endEncoding()
  command.commit()
  command.waitUntilCompleted()
  if let error = command.error { throw error }
  precondition(command.status == .completed)
  let bytes = readback.contents().assumingMemoryBound(to: UInt8.self)
  return (0..<4).flatMap { y in (0..<16).map { x in bytes[y * 256 + x] } }
}
`;
