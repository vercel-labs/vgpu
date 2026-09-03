import BackendSPI
import CapabilityPayloads
import PhysicalMetalCore

extension PhysicalMetalBackend: ResourceBackend {
  @inline(never)
  package func makeBuffer(byteCount: Int) -> UInt64 {
    c0_resource_payload() ^ UInt64(byteCount)
  }
}
