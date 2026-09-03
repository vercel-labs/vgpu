import VGPUABI

public enum EffectProgram {
  public static let descriptor = ProgramDescriptor(entryPoint: "fragmentMain")
}

public enum ComputeProgram {
  public static let descriptor = ProgramDescriptor(entryPoint: "computeMain")
}
