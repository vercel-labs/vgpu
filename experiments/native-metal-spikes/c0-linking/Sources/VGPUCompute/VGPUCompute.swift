import BackendSPI
import VGPUABI
import VGPUCore

public struct VGPUComputeProgram<Program>: Sendable {
  public let descriptor: ProgramDescriptor

  public init(descriptor: ProgramDescriptor) {
    self.descriptor = descriptor
  }
}

public extension VGPU {
  func compute<Program>(
    _ program: Program.Type,
    descriptor: ProgramDescriptor
  ) -> VGPUComputeProgram<Program> {
    VGPUComputeProgram(descriptor: descriptor)
  }

  @inline(never)
  func dispatch<Program>(
    _ program: VGPUComputeProgram<Program>,
    groups: Int
  ) throws -> UInt64 {
    guard let compute = backend as? any ComputeBackend else {
      throw VGPUError.capabilityUnavailable
    }
    return compute.encodeDispatch(program: program.descriptor, groups: groups)
  }
}
