import BackendSPI
import CapabilityPayloads
import PhysicalMetalCore
import VGPUABI

extension PhysicalMetalBackend: ComputeBackend {
  @inline(never)
  package func encodeDispatch(program: ProgramDescriptor, groups: Int) -> UInt64 {
    c0_compute_payload() ^ UInt64(program.entryPoint.utf8.count) ^ UInt64(groups)
  }
}
