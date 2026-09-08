import type { MetalPackageInput, MetalUniform } from "./index.js";
import { validateUniformLayout } from "./uniforms.js";
import { validateUniformSlots } from "./bindings.js";
import { validateCompute } from "./compute.js";

const asciiIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const metalFunctionName = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;
// The generated surface deliberately excludes contextual keywords as well as
// reserved words; it never escapes or silently renames an authored identity.
const swiftKeywords = new Set(
  `
associatedtype borrowing class consuming deinit enum extension fileprivate func import init
inout internal let nonisolated open operator precedencegroup private protocol public rethrows
static struct subscript typealias var break case catch continue default defer do else
fallthrough for guard if in repeat return switch throw where while Any as await false is nil
self Self super throws true try associativity async convenience didSet dynamic final get
indirect infix lazy left mutating none nonmutating optional override package postfix precedence
prefix Protocol required right set some Type unowned weak willSet actor any isolated macro sending
`
    .trim()
    .split(/\s+/)
);
const generatedNames = new Set(
  [
    "ShaderLoadError",
    "ShaderStage",
    "_ShaderLibrary",
    "Functions",
    "Metal",
    "Foundation",
    "Dispatch",
    "CryptoKit",
    "Swift",
    "PackageDescription",
    "Error",
    "String",
    "Data",
    "Bundle",
    "MTLFunction",
    "MTLLibrary",
    "MTLDevice",
    "MTLFunctionType",
    "DispatchData",
    "SHA256",
    "Sendable",
    "ShaderPackingError",
    "_ShaderPacking",
    "Uniforms",
    "Float",
    "Int",
    "UInt8",
    "UInt32",
    "SIMD2",
    "SIMD3",
    "SIMD4",
    "UnsafeMutableRawBufferPointer",
    "withUnsafeBytes",
    "Bindings",
    "ShaderBufferRange",
    "ShaderBufferSlot",
    "ShaderBindingError",
    "_ShaderBinding",
    "MTLBuffer",
    "MTLRenderCommandEncoder",
    "PreparedBindings",
    "Storage",
    "ShaderInternalBufferData",
    "MTLSize",
    "MTLComputeCommandEncoder",
  ].map((name) => name.toLowerCase())
);

export function validateMetalPackageInput(input: MetalPackageInput): void {
  validateMetalPackageInterface(input);
  if (
    !(input.library instanceof Uint8Array) ||
    input.library.byteLength === 0
  ) {
    throw new TypeError("library must be a nonempty Uint8Array");
  }
}

export function validateMetalPackageInterface(
  input: Pick<MetalPackageInput, "moduleName" | "programs">
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be a Metal package input record");
  }
  validateSwiftIdentifier(input.moduleName, "moduleName");
  if (!Array.isArray(input.programs) || input.programs.length === 0) {
    throw new TypeError("programs must be a nonempty array");
  }
  const names = new Set([input.moduleName.toLowerCase()]);
  for (const [index, program] of input.programs.entries()) {
    if (
      program === null ||
      typeof program !== "object" ||
      Array.isArray(program)
    ) {
      throw new TypeError(`programs[${index}] must be a program record`);
    }
    validateSwiftIdentifier(program.name, `programs[${index}].name`);
    const name = program.name.toLowerCase();
    if (names.has(name)) {
      throw new TypeError(
        `programs[${index}].name collides with the module or another program`
      );
    }
    names.add(name);
    validateFunctions(program.functions, `programs[${index}].functions`);
    if (program.uniforms !== undefined && !Array.isArray(program.uniforms)) {
      throw new TypeError(`programs[${index}].uniforms must be an array`);
    }
    const uniformNames = new Set<string>();
    const uniformTypes = new Map<string, string>();
    for (const [uniformIndex, uniform] of (program.uniforms ?? []).entries()) {
      const label = `programs[${index}].uniforms[${uniformIndex}]`;
      if (uniform === null || typeof uniform !== "object" || Array.isArray(uniform)) {
        throw new TypeError(`${label} must be a uniform record`);
      }
      validateSwiftIdentifier(uniform.name, `${label}.name`);
      validateSwiftIdentifier(uniform.typeName, `${label}.typeName`);
      if ([program.name, input.moduleName, "load"].some((name) => name.toLowerCase() === uniform.typeName.toLowerCase())) {
        throw new TypeError(`${label}.typeName collides with a containing declaration`);
      }
      if (!Array.isArray(uniform.members) || uniform.members.length === 0) {
        throw new TypeError(`${label}.members must be a nonempty array`);
      }
      const memberNames = new Set<string>();
      for (const member of uniform.members) {
        if (member === null || typeof member !== "object" || Array.isArray(member)) {
          throw new TypeError(`${label}.members must contain member records`);
        }
        validateSwiftIdentifier(member.name, `${label}.members.name`);
        const name = member.name.toLowerCase();
        if (memberNames.has(name)) throw new TypeError(`${label} has duplicate member names`);
        memberNames.add(name);
      }
      validateUniformLayout(uniform, label);
      const uniformName = uniform.name.toLowerCase();
      if (uniformNames.has(uniformName)) throw new TypeError(`${label} duplicates a uniform binding name`);
      uniformNames.add(uniformName);
      const typeName = uniform.typeName.toLowerCase();
      const shape = JSON.stringify({ name: uniform.typeName, members: uniform.members.map(({ name, type }: MetalUniform["members"][number]) => ({ name, type })) });
      if (uniformTypes.has(typeName) && uniformTypes.get(typeName) !== shape) {
        throw new TypeError(`${label} has an ambiguous shared Swift type identity`);
      }
      uniformTypes.set(typeName, shape);
    }
    validateUniformSlots(program.uniforms ?? [], Object.keys(program.functions), `programs[${index}].uniforms`);
    validateCompute(program, `programs[${index}].compute`);
  }
}

function validateFunctions(functions: unknown, label: string): void {
  if (
    functions === null ||
    typeof functions !== "object" ||
    Array.isArray(functions)
  ) {
    throw new TypeError(`${label} must be a selected stage map`);
  }
  const stages = Reflect.ownKeys(functions);
  if (
    stages.length === 0 ||
    stages.some(
      (stage) =>
        stage !== "vertex" && stage !== "fragment" && stage !== "compute"
    )
  ) {
    throw new TypeError(
      `${label} must select vertex, fragment, or compute stages`
    );
  }
  if (stages.includes("compute") && stages.length !== 1) {
    throw new TypeError(`${label} cannot mix compute and render stages`);
  }
  for (const stage of stages) {
    const name: unknown = Reflect.get(functions, stage);
    if (typeof name !== "string" || !metalFunctionName.test(name)) {
      throw new TypeError(
        `${label}.${String(stage)} must be a nonempty emitted Metal identifier or qualified name`
      );
    }
  }
}

export function validateSwiftIdentifier(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !asciiIdentifier.test(value) ||
    value === "_" ||
    value.startsWith("__") ||
    value.toLowerCase().startsWith("_layout_")
  ) {
    throw new TypeError(`${label} must be a supported Swift ASCII identifier`);
  }
  if (swiftKeywords.has(value)) {
    throw new TypeError(`${label} must not be a Swift keyword`);
  }
  if (generatedNames.has(value.toLowerCase())) {
    throw new TypeError(`${label} collides with a generated or imported name`);
  }
}
