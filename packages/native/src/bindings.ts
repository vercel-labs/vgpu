import type { MetalUniform } from "./uniforms.js";

export interface MetalUniformSlot {
  readonly stage: "vertex" | "fragment";
  readonly index: number;
}

export function hasUniformBindings(uniforms: readonly MetalUniform[]): boolean {
  return uniforms.some((uniform) => uniform.slots !== undefined);
}

export function validateUniformSlots(
  uniforms: readonly MetalUniform[],
  selectedStages: readonly string[],
  label: string
): void {
  if (!hasUniformBindings(uniforms)) return;
  const occupied = new Set<string>();
  for (const [index, uniform] of uniforms.entries()) {
    const slotLabel = `${label}[${index}].slots`;
    if (
      !Array.isArray(uniform.slots) ||
      uniform.slots.length === 0 ||
      uniform.slots.length > 2
    ) {
      throw new TypeError(
        `${slotLabel} must map every uniform to one or two selected render stages`
      );
    }
    const stages = new Set<string>();
    for (const slot of uniform.slots) {
      if (
        slot === null ||
        typeof slot !== "object" ||
        Array.isArray(slot) ||
        Reflect.ownKeys(slot).length !== 2 ||
        !Object.hasOwn(slot, "stage") ||
        !Object.hasOwn(slot, "index") ||
        (slot.stage !== "vertex" && slot.stage !== "fragment") ||
        !selectedStages.includes(slot.stage) ||
        !Number.isInteger(slot.index) ||
        slot.index < 0 ||
        slot.index > 30
      ) {
        throw new TypeError(
          `${slotLabel} must contain selected render stages with Metal buffer indices from 0 through 30`
        );
      }
      const key = `${slot.stage}:${slot.index}`;
      if (stages.has(slot.stage) || occupied.has(key)) {
        throw new TypeError(
          `${slotLabel} contains an ambiguous stage or overlapping shader buffer slot`
        );
      }
      stages.add(slot.stage);
      occupied.add(key);
    }
  }
}

function orderedUniforms(uniforms: readonly MetalUniform[]): MetalUniform[] {
  return [...uniforms].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
}

function orderedSlots(slots: readonly MetalUniformSlot[]): MetalUniformSlot[] {
  return [...slots].sort((a, b) =>
    a.stage === b.stage ? a.index - b.index : a.stage === "vertex" ? -1 : 1
  );
}

export function generateUniformSlots(uniform: MetalUniform): string {
  if (uniform.slots === undefined) return "";
  return `      public let slots: [ShaderBufferSlot] = [${orderedSlots(
    uniform.slots
  )
    .map((slot) => `.init(stage: .${slot.stage}, index: ${slot.index})`)
    .join(", ")}]\n`;
}

export function generateBindingsDeclaration(
  uniforms: readonly MetalUniform[]
): string {
  if (!hasUniformBindings(uniforms)) return "";
  const ordered = orderedUniforms(uniforms);
  return `  public struct Bindings {
${ordered
  .map((uniform) => `    public let ${uniform.name}: ShaderBufferRange`)
  .join("\n")}

    public init(${ordered
      .map((uniform) => `${uniform.name}: ShaderBufferRange`)
      .join(", ")}) {
${ordered
  .map((uniform) => `      self.${uniform.name} = ${uniform.name}`)
  .join("\n")}
    }
  }

`;
}

export function generateBindingMethods(
  uniforms: readonly MetalUniform[]
): string {
  if (!hasUniformBindings(uniforms)) return "";
  return `
    public func validate(_ bindings: Bindings) throws {
${orderedUniforms(uniforms)
  .map(
    (uniform) =>
      `      try _ShaderBinding.validate(bindings.${uniform.name}, name: "${uniform.name}", byteCount: ${uniform.byteCount}, alignment: ${uniform.alignment}, device: _device)`
  )
  .join("\n")}
    }

    public func bind(_ bindings: Bindings, to encoder: any MTLRenderCommandEncoder) throws {
      guard encoder.device === _device else {
        throw ShaderBindingError.encoderDeviceMismatch
      }
      try validate(bindings)
${orderedUniforms(uniforms)
  .flatMap((uniform) =>
    orderedSlots(uniform.slots!).map(
      (slot) =>
        `      encoder.set${
          slot.stage === "vertex" ? "Vertex" : "Fragment"
        }Buffer(bindings.${uniform.name}.buffer, offset: bindings.${
          uniform.name
        }.offset, index: ${slot.index})`
    )
  )
  .join("\n")}
    }
`;
}

export const bindingSupport = `public enum ShaderBindingError: Error {
  case invalidRange(binding: String, offset: Int, length: Int, bufferLength: Int)
  case insufficientRange(binding: String, required: Int, actual: Int)
  case misalignedOffset(binding: String, required: Int, actual: Int)
  case resourceDeviceMismatch(binding: String)
  case encoderDeviceMismatch
  case unrepresentableLength(binding: String, maximum: Int, actual: Int)
  case preparedDeviceMismatch
}

public struct ShaderBufferRange {
  public let buffer: any MTLBuffer
  public let offset: Int
  public let length: Int

  public init(buffer: any MTLBuffer, offset: Int, length: Int) {
    self.buffer = buffer
    self.offset = offset
    self.length = length
  }
}

public struct ShaderBufferSlot: Sendable {
  public let stage: ShaderStage
  public let index: Int
}

private enum _ShaderBinding {
  static func validate(_ range: ShaderBufferRange, name: String, byteCount: Int, alignment: Int, device: any MTLDevice, constantBuffer: Bool = true) throws {
    guard range.offset >= 0, range.length >= 0,
          range.offset <= range.buffer.length,
          range.length <= range.buffer.length - range.offset else {
      throw ShaderBindingError.invalidRange(binding: name, offset: range.offset, length: range.length, bufferLength: range.buffer.length)
    }
    guard range.length >= byteCount else {
      throw ShaderBindingError.insufficientRange(binding: name, required: byteCount, actual: range.length)
    }
    // Apple GPU constant buffers require 4-byte offsets. The 256-byte fallback
    // is a conservative compatibility policy for devices outside this release's
    // tested Apple-family matrix, not a universal Metal requirement.
    let requiredAlignment = constantBuffer ? Swift.max(alignment, device.supportsFamily(.apple1) ? 4 : 256) : alignment
    guard range.offset % requiredAlignment == 0 else {
      throw ShaderBindingError.misalignedOffset(binding: name, required: requiredAlignment, actual: range.offset)
    }
    guard range.buffer.device === device else {
      throw ShaderBindingError.resourceDeviceMismatch(binding: name)
    }
  }
}
`;
