public struct VGPUABICompatibility: Sendable {
  public let supportedVersions: ClosedRange<Int>

  public init(supportedVersions: ClosedRange<Int>) {
    self.supportedVersions = supportedVersions
  }

  public func supports(requiredVersion: Int) -> Bool {
    supportedVersions.contains(requiredVersion)
  }
}
