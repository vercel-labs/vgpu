import BackendSPI
import CapabilityPayloads
import VGPUABI

extension UnifiedMetalBackend: ComputeBackend {
  @inline(never)
  func encodeDispatch(program: ProgramDescriptor, groups: Int) -> UInt64 {
    c0_compute_payload() ^ UInt64(program.entryPoint.utf8.count) ^ UInt64(groups)
  }
}
