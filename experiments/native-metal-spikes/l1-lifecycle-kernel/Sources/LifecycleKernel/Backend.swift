import Foundation

package struct VGPUBackendGeneration: Hashable, Sendable {
  package let rawValue: UInt64

  package init(rawValue: UInt64) {
    self.rawValue = rawValue
  }
}

package protocol VGPULifecycleBackend: AnyObject, Sendable {
  func allocateGeneration(label: String) throws -> VGPUBackendGeneration

  func readGeneration(_ generation: VGPUBackendGeneration) async throws -> [UInt8]

  func execute(
    label: String,
    generations: [VGPUBackendGeneration]
  ) async throws

  func releaseGeneration(_ generation: VGPUBackendGeneration)
}
