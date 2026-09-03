import BackendSPI
import CapabilityPayloads
import VGPUABI

extension UnifiedMetalBackend: RenderBackend {
  @inline(never)
  func encodeDraw(program: ProgramDescriptor) -> UInt64 {
    c0_render_payload() ^ UInt64(program.entryPoint.utf8.count)
  }
}
