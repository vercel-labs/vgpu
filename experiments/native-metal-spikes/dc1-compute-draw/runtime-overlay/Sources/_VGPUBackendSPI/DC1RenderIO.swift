import Foundation

package enum VGPUBackendColorLoad: Sendable {
  case clear(red: Double, green: Double, blue: Double, alpha: Double)
  case preserve
}

extension VGPURenderBackend {
  package func readOffscreenTarget(_ handle: VGPUBackendTargetHandle) async throws -> Data {
    throw NSError(domain: "VGPU-NATIVE-RENDER-READ-UNAVAILABLE", code: 1)
  }
}
