export type UniformFieldType = "f32" | "vec2f" | "vec3f" | "vec4f";

/** Physical layout projected from one reflected WGSL uniform binding. */
export interface MetalUniform {
  readonly name: string;
  readonly typeName: string;
  readonly byteCount: number;
  readonly alignment: number;
  readonly members: readonly {
    readonly name: string;
    readonly type: UniformFieldType;
    readonly offset: number;
  }[];
}

const swiftTypes: Record<UniformFieldType, string> = {
  f32: "Float",
  vec2f: "SIMD2<Float>",
  vec3f: "SIMD3<Float>",
  vec4f: "SIMD4<Float>",
};
const components: Record<UniformFieldType, readonly string[]> = {
  f32: [""],
  vec2f: [".x", ".y"],
  vec3f: [".x", ".y", ".z"],
  vec4f: [".x", ".y", ".z", ".w"],
};

export function validateUniformLayout(uniform: MetalUniform, label: string): void {
  const isSize = (value: number) => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
  if (!isSize(uniform.byteCount) || !isSize(uniform.alignment) ||
      !Number.isInteger(Math.log2(uniform.alignment)) || uniform.byteCount % uniform.alignment !== 0) {
    throw new TypeError(`${label} must have a positive uint32 size and power-of-two alignment`);
  }
  let end = 0;
  for (const member of uniform.members) {
    if (typeof member.type !== "string" || !Object.hasOwn(components, member.type)) {
      throw new TypeError(`${label} supports only f32, vec2f, vec3f, and vec4f members`);
    }
    const width = components[member.type].length;
    const alignment = width === 3 ? 16 : width * 4;
    if (!Number.isInteger(member.offset) || member.offset < 0 ||
        member.offset % alignment !== 0 || uniform.alignment < alignment ||
        member.offset + width * 4 > uniform.byteCount) {
      throw new TypeError(`${label} member offset or alignment is outside the supported layout`);
    }
    if (member.offset < end) throw new TypeError(`${label} members overlap or are out of order`);
    end = member.offset + width * 4;
  }
}

export function generateUniformDeclarations(inputUniforms: readonly MetalUniform[]): string {
  const uniforms = [...inputUniforms].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (uniforms.length === 0) return "";
  const types = new Map(uniforms.map((uniform) => [uniform.typeName, uniform]));
  return `${[...types.values()].map((uniform) => `  public struct ${uniform.typeName}: Sendable {
${uniform.members.map((member) => `    public var ${member.name}: ${swiftTypes[member.type]}`).join("\n")}

    public init(${uniform.members.map((member) => `${member.name}: ${swiftTypes[member.type]}`).join(", ")}) {
${uniform.members.map((member) => `      self.${member.name} = ${member.name}`).join("\n")}
    }
  }`).join("\n\n")}

  public enum Uniforms {
${uniforms.map((uniform) => `    public static let ${uniform.name} = _Layout_${uniform.name}()

    public struct _Layout_${uniform.name}: Sendable {
      fileprivate init() {}
      public let byteCount = ${uniform.byteCount}
      public let alignment = ${uniform.alignment}

      public func pack(_ value: ${uniform.typeName}, into destination: UnsafeMutableRawBufferPointer) throws {
        guard destination.count >= byteCount else {
          throw ShaderPackingError.destinationTooSmall(required: byteCount, actual: destination.count)
        }
        for index in 0..<byteCount { destination[index] = 0 }
${uniform.members.flatMap((member) => components[member.type].map((component, index) =>
  `        _ShaderPacking.write(value.${member.name}${component}, into: destination, at: ${member.offset + index * 4})`
)).join("\n")}
      }
    }`).join("\n\n")}
  }

`;
}

export const uniformPackingSupport = `public enum ShaderPackingError: Error {
  case destinationTooSmall(required: Int, actual: Int)
}

private enum _ShaderPacking {
  static func write(_ value: Float, into destination: UnsafeMutableRawBufferPointer, at offset: Int) {
    var bits = value.bitPattern.littleEndian
    withUnsafeBytes(of: &bits) { source in
      destination.baseAddress!.advanced(by: offset).copyMemory(from: source.baseAddress!, byteCount: 4)
    }
  }
}
`;
