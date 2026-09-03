import BackendSPI
import VGPUABI
import VGPUCore

public struct VGPUEffect<Program>: Sendable {
  public let descriptor: ProgramDescriptor

  public init(descriptor: ProgramDescriptor) {
    self.descriptor = descriptor
  }
}

public extension VGPU {
  func effect<Program>(
    _ program: Program.Type,
    descriptor: ProgramDescriptor
  ) -> VGPUEffect<Program> {
    VGPUEffect(descriptor: descriptor)
  }

  @inline(never)
  func draw<Program>(_ effect: VGPUEffect<Program>) throws -> UInt64 {
    guard let render = backend as? any RenderBackend else {
      throw VGPUError.capabilityUnavailable
    }
    return render.encodeDraw(program: effect.descriptor)
  }
}
