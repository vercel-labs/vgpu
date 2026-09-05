import Foundation
import Metal

package final class MetalCore: @unchecked Sendable {
  package let device: MTLDevice
  package let contextIdentity: UInt64

  package init(device: MTLDevice, contextIdentity: UInt64) {
    self.device = device
    self.contextIdentity = contextIdentity
  }
}
