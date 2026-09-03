import BackendSPI
import CapabilityPayloads
import PhysicalMetalCore
import VGPUABI

extension PhysicalMetalBackend: RenderBackend {
  @inline(never)
  package func encodeDraw(program: ProgramDescriptor) -> UInt64 {
    c0_render_payload() ^ UInt64(program.entryPoint.utf8.count)
  }
}
