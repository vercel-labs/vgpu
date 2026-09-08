import { MetalCompileError } from "./errors.js";

/** Isolate each independently translated stage without renaming shader declarations. */
export function namespaceMsl(msl: string, namespace: string): string {
  const preamble = "#include <metal_stdlib>\nusing namespace metal;\n";
  if (!msl.startsWith(preamble))
    throw new MetalCompileError(
      "translation",
      "Tint MSL has an unsupported preamble"
    );
  return `${preamble}namespace ${namespace} {\n${msl.slice(
    preamble.length
  )}\n}\n`;
}

/** Check the emitted declaration, excluding comments and string/character literals. */
export function hasMslEntryDeclaration(
  msl: string,
  stage: string,
  emittedName: string
): boolean {
  const keyword = stage === "compute" ? "kernel" : stage;
  const escaped = emittedName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const code = msl.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gu,
    (literal) => literal.replace(/[^\n]/gu, " ")
  );
  return new RegExp(
    `^\\s*${keyword}\\s+[^{};]*\\b${escaped}\\s*\\([^{};]*\\)\\s*\\{`,
    "mu"
  ).test(code);
}
