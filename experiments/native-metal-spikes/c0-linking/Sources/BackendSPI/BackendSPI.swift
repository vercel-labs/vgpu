import VGPUABI

package protocol CoreBackend: AnyObject {
  func coreFingerprint() -> UInt64
}

package protocol ResourceBackend: AnyObject {
  func makeBuffer(byteCount: Int) -> UInt64
}

package protocol RenderBackend: AnyObject {
  func encodeDraw(program: ProgramDescriptor) -> UInt64
}

package protocol ComputeBackend: AnyObject {
  func encodeDispatch(program: ProgramDescriptor, groups: Int) -> UInt64
}
