import Foundation
import Metal
import VGPUABI
import _VGPUBackendSPI
import _VGPUMetalCoreImpl
import _VGPUMetalProgramImpl
import _VGPUMetalResourcesImpl

private struct DC1Target: @unchecked Sendable {
  let texture: MTLTexture
  let width: Int
  let height: Int
}

private struct DC1Draw: @unchecked Sendable {
  let descriptor: _VGPUDrawProgramDescriptor
  let pipeline: MTLRenderPipelineState
}

package final class DC1MetalRenderBackend: @unchecked Sendable {
  private let core: MetalCore
  private let resources: MetalResourceBackend
  private let programs: DC1MetalProgramStore
  private let lock = NSLock()
  private var nextTarget: UInt64 = 1
  private var nextDraw: UInt64 = 1
  private var targets: [VGPUBackendTargetHandle: DC1Target] = [:]
  private var draws: [VGPUBackendDrawProgramHandle: DC1Draw] = [:]

  package init(core: MetalCore, resources: MetalResourceBackend, programs: DC1MetalProgramStore) {
    self.core = core
    self.resources = resources
    self.programs = programs
  }

  package func createTarget(width: Int, height: Int) throws -> VGPUBackendTargetHandle {
    guard width > 0, height > 0 else { throw DC1MetalError.invalidProgram }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: false)
    descriptor.storageMode = .private
    descriptor.usage = [.renderTarget]
    guard let texture = core.device.makeTexture(descriptor: descriptor) else {
      throw DC1MetalError.commandResources
    }
    lock.lock()
    defer { lock.unlock() }
    let handle = VGPUBackendTargetHandle(rawValue: nextTarget)
    nextTarget += 1
    targets[handle] = DC1Target(texture: texture, width: width, height: height)
    return handle
  }

  package func prepare(_ descriptor: _VGPUDrawProgramDescriptor) throws
    -> VGPUBackendDrawProgramHandle
  {
    guard descriptor.artifactID == "dc1-compute-draw", descriptor.programID == "ConsumePacket",
      descriptor.vertexEntryPointID == "vertexMain",
      descriptor.fragmentEntryPointID == "fragmentMain", let artifact = descriptor.artifact
    else { throw DC1MetalError.invalidProgram }
    let loaded = try programs.load(artifact)
    guard let vertex = loaded.library.makeFunction(name: loaded.vertexEntry),
      let fragment = loaded.library.makeFunction(name: loaded.fragmentEntry)
    else { throw DC1MetalError.invalidProgram }
    let pipelineDescriptor = MTLRenderPipelineDescriptor()
    pipelineDescriptor.vertexFunction = vertex
    pipelineDescriptor.fragmentFunction = fragment
    pipelineDescriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
    var reflection: MTLRenderPipelineReflection?
    let pipeline = try core.device.makeRenderPipelineState(
      descriptor: pipelineDescriptor, options: [.bindingInfo], reflection: &reflection)
    guard let reflection,
      reflection.vertexBindings.filter(\.isUsed).isEmpty,
      reflection.fragmentBindings.filter(\.isUsed).isEmpty
    else { throw DC1MetalError.invalidProgram }
    lock.lock()
    defer { lock.unlock() }
    let handle = VGPUBackendDrawProgramHandle(rawValue: nextDraw)
    nextDraw += 1
    draws[handle] = DC1Draw(descriptor: descriptor, pipeline: pipeline)
    return handle
  }

  package func submit(_ commands: [VGPUBackendFrameCommand]) throws -> any VGPUBackendExecution {
    guard commands.count == 1, commands[0].draws.count == 1 else {
      throw DC1MetalError.invalidProgram
    }
    let command = commands[0]
    let draw = command.draws[0]
    guard let target = target(for: command.target),
      let prepared = preparedDraw(for: draw.program),
      try resources.supportsUsage(.indirect, for: draw.snapshot),
      draw.snapshot.contextIdentity == core.contextIdentity
    else { throw DC1MetalError.invalidProgram }
    let (viewOffset, viewOverflow) = draw.snapshot.offset.addingReportingOverflow(
      draw.viewRange.lowerBound)
    let (expectedOffset, consumerOverflow) = viewOffset.addingReportingOverflow(
      draw.consumerByteOffset)
    let (physicalEnd, endOverflow) = draw.physicalByteOffset.addingReportingOverflow(16)
    guard !viewOverflow, !consumerOverflow, !endOverflow,
      draw.physicalByteOffset == expectedOffset,
      draw.physicalByteOffset >= 0,
      physicalEnd <= draw.snapshot.backingByteCount
    else { throw DC1MetalError.invalidProgram }
    let buffer = try resources.buffer(for: draw.snapshot)
    guard let commandBuffer = core.commandQueue.makeCommandBuffer() else {
      throw DC1MetalError.commandResources
    }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target.texture
    switch command.colorLoad {
    case .preserve: pass.colorAttachments[0].loadAction = .load
    case .clear(let red, let green, let blue, let alpha):
      pass.colorAttachments[0].loadAction = .clear
      pass.colorAttachments[0].clearColor = MTLClearColor(
        red: red, green: green, blue: blue, alpha: alpha)
    }
    pass.colorAttachments[0].storeAction = .store
    guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else {
      throw DC1MetalError.commandResources
    }
    encoder.setRenderPipelineState(prepared.pipeline)
    encoder.drawPrimitives(
      type: .triangle, indirectBuffer: buffer,
      indirectBufferOffset: draw.physicalByteOffset)
    encoder.endEncoding()
    commandBuffer.commit()
    DC1MetalAudit.shared.recordDraw(
      identity: draw.snapshot.allocationIdentity,
      generation: draw.snapshot.generation,
      viewRange: draw.viewRange,
      consumerByteOffset: draw.consumerByteOffset,
      physicalByteOffset: draw.physicalByteOffset,
      directVertexCount: draw.directVertexCount)
    return DC1MetalExecution(commandBuffer)
  }

  package func read(_ handle: VGPUBackendTargetHandle) async throws -> Data {
    let target = target(for: handle)
    guard let target else { throw DC1MetalError.invalidProgram }
    let bytesPerRow = ((target.width * 4 + 255) / 256) * 256
    let length = bytesPerRow * target.height
    guard let output = core.device.makeBuffer(length: length, options: .storageModeShared),
      let commandBuffer = core.commandQueue.makeCommandBuffer(),
      let blit = commandBuffer.makeBlitCommandEncoder()
    else { throw DC1MetalError.commandResources }
    blit.copy(
      from: target.texture, sourceSlice: 0, sourceLevel: 0,
      sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
      sourceSize: MTLSize(width: target.width, height: target.height, depth: 1),
      to: output, destinationOffset: 0, destinationBytesPerRow: bytesPerRow,
      destinationBytesPerImage: length)
    blit.endEncoding()
    commandBuffer.commit()
    try await DC1MetalExecution(commandBuffer).wait()
    var result = Data(capacity: target.width * target.height * 4)
    for row in 0..<target.height {
      result.append(
        Data(
          bytes: output.contents().advanced(by: row * bytesPerRow),
          count: target.width * 4))
    }
    return result
  }

  private func target(for handle: VGPUBackendTargetHandle) -> DC1Target? {
    lock.lock()
    defer { lock.unlock() }
    return targets[handle]
  }

  private func preparedDraw(for handle: VGPUBackendDrawProgramHandle) -> DC1Draw? {
    lock.lock()
    defer { lock.unlock() }
    return draws[handle]
  }
}

extension MetalBackend {
  package var dc1RenderBackend: DC1MetalRenderBackend {
    capabilityState(DC1MetalRenderBackend.self) {
      DC1MetalRenderBackend(core: core, resources: resourceBackend, programs: dc1ProgramStore)
    }
  }
}

extension MetalBackend: VGPURenderBackend {
  package func createOffscreenTarget(width: Int, height: Int) throws -> VGPUBackendTargetHandle {
    try dc1RenderBackend.createTarget(width: width, height: height)
  }
  package func prepareDraw(_ descriptor: _VGPUDrawProgramDescriptor) throws
    -> VGPUBackendDrawProgramHandle
  {
    try dc1RenderBackend.prepare(descriptor)
  }
  package func submitFrame(_ commands: [VGPUBackendFrameCommand]) throws -> any VGPUBackendExecution
  {
    try dc1RenderBackend.submit(commands)
  }
  package func readOffscreenTarget(_ handle: VGPUBackendTargetHandle) async throws -> Data {
    try await dc1RenderBackend.read(handle)
  }
}
