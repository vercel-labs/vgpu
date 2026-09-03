import BackendSPI
import CapabilityPayloads

extension UnifiedMetalBackend: ResourceBackend {
  @inline(never)
  func makeBuffer(byteCount: Int) -> UInt64 {
    c0_resource_payload() ^ UInt64(byteCount)
  }
}
