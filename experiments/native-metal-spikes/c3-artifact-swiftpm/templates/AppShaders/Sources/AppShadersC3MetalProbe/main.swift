import AppShaders
import Foundation
import Metal

struct C3MetalProbeError: Error, CustomStringConvertible {
  let description: String
}

guard CommandLine.arguments == [CommandLine.arguments[0], "--metal-readback"] else {
  throw C3MetalProbeError(description: "Usage: AppShadersC3MetalProbe --metal-readback")
}

guard AppShadersArtifact.payloadKind == "metal-library" else {
  throw C3MetalProbeError(
    description: "Refusing to pass the C3a structural sentinel to Metal."
  )
}

let payloadURL = try AppShadersArtifact.payloadURL()
let payloadHash = try AppShadersArtifact.verifyPackagedPayload()
guard let device = MTLCreateSystemDefaultDevice() else {
  throw C3MetalProbeError(description: "No default Metal device is available.")
}

var readback: [UInt32] = []
try AppShadersArtifact.validateApplicationCompatibility(
  selection: AppShadersArtifact.noopComputeSelection,
  payloadSHA256: payloadHash
) { selection in
  guard selection == AppShadersArtifact.noopComputeSelection,
    let metalEntryPoint = selection.program.metalEntryPoint(for: selection.stage)
  else {
    throw C3MetalProbeError(description: "Unexpected validated pipeline selection.")
  }
  let library = try device.makeLibrary(URL: payloadURL)
  let projection = AppShadersArtifact.noopProjection
  guard projection.metalEntryPoint == metalEntryPoint,
    let function = library.makeFunction(name: metalEntryPoint)
  else {
    throw C3MetalProbeError(
      description: "The packaged library has no \(metalEntryPoint) function."
    )
  }

  let pipeline = try device.makeComputePipelineState(function: function)
  guard let queue = device.makeCommandQueue(),
    let commandBuffer = queue.makeCommandBuffer(),
    let encoder = commandBuffer.makeComputeCommandEncoder(),
    let buffer = device.makeBuffer(
      length: projection.minimumBufferByteCount,
      options: [.storageModeShared]
    )
  else {
    throw C3MetalProbeError(description: "Failed to allocate the C3b Metal objects.")
  }

  encoder.setComputePipelineState(pipeline)
  encoder.setBuffer(buffer, offset: 0, index: projection.bufferIndex)
  encoder.dispatchThreads(
    MTLSize(
      width: projection.workgroupWidth,
      height: projection.workgroupHeight,
      depth: projection.workgroupDepth
    ),
    threadsPerThreadgroup: MTLSize(
      width: projection.workgroupWidth,
      height: projection.workgroupHeight,
      depth: projection.workgroupDepth
    )
  )
  encoder.endEncoding()
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()

  guard commandBuffer.status == .completed else {
    throw C3MetalProbeError(
      description:
        "Metal command buffer failed: \(commandBuffer.error?.localizedDescription ?? "unknown error")"
    )
  }

  let values = buffer.contents().bindMemory(
    to: UInt32.self,
    capacity: projection.elementCount
  )
  readback = (0..<projection.elementCount).map { values[$0] }
}

let expectedReadback = (0..<AppShadersArtifact.noopProjection.elementCount).map(UInt32.init)
guard readback == expectedReadback else {
  throw C3MetalProbeError(description: "Unexpected C3b readback: \(readback)")
}

print("C3b Metal readback passed on \(device.name): \(readback)")
