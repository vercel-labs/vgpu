public struct ProgramDescriptor: Hashable, Sendable {
  public let entryPoint: String

  public init(entryPoint: String) {
    self.entryPoint = entryPoint
  }
}
