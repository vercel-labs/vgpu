import Foundation
import Metal
import VGPUABI
import _VGPUBackendSPI
import _VGPUMetalCoreImpl
import _VGPUMetalProgramImpl
import _VGPUMetalResourcesImpl

private struct DC1PreparedCompute {
  let descriptor: _VGPUProgramDescriptor
  let pipeline: MTLComputePipelineState
}

package final class DC1MetalComputeBackend: @unchecked Sendable {
  private let core: MetalCore
  private let resources: MetalResourceBackend
  private let programs: DC1MetalProgramStore
  private let lock = NSLock()
  private var prepared: [VGPUBackendProgramHandle: DC1PreparedCompute] = [:]
  private var nextHandle: UInt64 = 0xd100_0000_0000_0001

  package init(core: MetalCore, resources: MetalResourceBackend, programs: DC1MetalProgramStore) {
    self.core = core
    self.resources = resources
    self.programs = programs
  }

  package func prepare(_ descriptor: _VGPUProgramDescriptor) throws -> VGPUBackendProgramHandle {
    guard descriptor.artifactID == "dc1-compute-draw", descriptor.programID == "ProducePacket",
      descriptor.entryPointID == "produce", descriptor.workgroupSize == (1, 1, 1),
      descriptor.bindings.count == 1, descriptor.bindings[0].ordinal == 0,
      descriptor.bindings[0].access == .readWrite, !descriptor.bindings[0].runtimeSized,
      let artifact = descriptor.artifact
    else { throw DC1MetalError.invalidProgram }
    let loaded = try programs.load(artifact)
    guard let function = loaded.library.makeFunction(name: loaded.computeEntry) else {
      throw DC1MetalError.invalidProgram
    }
    var reflection: MTLComputePipelineReflection?
    let pipeline = try core.device.makeComputePipelineState(
      function: function, options: .bindingInfo, reflection: &reflection)
    guard let reflection,
      reflection.bindings.filter(\.isUsed).count == 1,
      let binding = reflection.bindings.filter(\.isUsed).first as? MTLBufferBinding,
      binding.index == 0, binding.access == .readWrite,
      binding.bufferDataSize == 32, binding.bufferAlignment == 4
    else { throw DC1MetalError.invalidProgram }
    lock.lock()
    defer { lock.unlock() }
    let handle = VGPUBackendProgramHandle(rawValue: nextHandle)
    nextHandle += 1
    prepared[handle] = DC1PreparedCompute(descriptor: descriptor, pipeline: pipeline)
    return handle
  }

  package func submit(_ command: VGPUBackendComputeCommand) throws -> any VGPUBackendExecution {
    lock.lock()
    let program = prepared[command.programHandle]
    lock.unlock()
    guard let program, program.descriptor == command.program,
      command.threadgroups == (1, 1, 1), command.bindings.count == 1,
      command.bindings[0].ordinal == 0, command.bindings[0].boundByteCount == 32,
      command.bindings[0].elementCount == nil,
      command.bindings[0].snapshot.access == .readWrite,
      try resources.supportsUsage(.binding, for: command.bindings[0].snapshot)
    else { throw DC1MetalError.invalidProgram }
    let binding = command.bindings[0]
    let buffer = try resources.buffer(for: binding.snapshot)
    let (end, overflow) = binding.snapshot.offset.addingReportingOverflow(32)
    guard !overflow, binding.snapshot.offset >= 0, end <= buffer.length,
      buffer.device === core.device,
      let commandBuffer = core.commandQueue.makeCommandBuffer(),
      let encoder = commandBuffer.makeComputeCommandEncoder()
    else { throw DC1MetalError.commandResources }
    encoder.setComputePipelineState(program.pipeline)
    encoder.setBuffer(buffer, offset: binding.snapshot.offset, index: 0)
    encoder.dispatchThreadgroups(
      MTLSize(width: 1, height: 1, depth: 1),
      threadsPerThreadgroup: MTLSize(width: 1, height: 1, depth: 1))
    encoder.endEncoding()
    commandBuffer.commit()
    DC1MetalAudit.shared.recordCompute(
      identity: binding.snapshot.allocationIdentity, generation: binding.snapshot.generation)
    return DC1MetalExecution(commandBuffer)
  }
}

extension MetalBackend {
  package var dc1ComputeBackend: DC1MetalComputeBackend {
    capabilityState(DC1MetalComputeBackend.self) {
      DC1MetalComputeBackend(core: core, resources: resourceBackend, programs: dc1ProgramStore)
    }
  }
}
