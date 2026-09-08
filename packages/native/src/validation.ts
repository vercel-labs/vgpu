import type { MetalPackageInput } from "./index.js";

const asciiIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
  ].map((name) => name.toLowerCase())
);

export function validateMetalPackageInput(input: MetalPackageInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be a Metal package input record");
  }
  validateSwiftIdentifier(input.moduleName, "moduleName");
  if (
    !(input.library instanceof Uint8Array) ||
    input.library.byteLength === 0
  ) {
    throw new TypeError("library must be a nonempty Uint8Array");
  }
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
    if (typeof name !== "string" || !asciiIdentifier.test(name)) {
      throw new TypeError(
        `${label}.${String(stage)} must be a nonempty emitted Metal identifier`
      );
    }
  }
}

function validateSwiftIdentifier(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !asciiIdentifier.test(value) ||
    value === "_" ||
    value.startsWith("__")
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
