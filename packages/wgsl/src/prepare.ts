import { reflectSource } from "./runtime/reflect-source.ts";
import { wgslError } from "./runtime/errors.ts";
import { normalizePreparationInput } from "./preparation/normalize-input.ts";
import { serializeReflection } from "./preparation/serialize-reflection.ts";
import { sourceChecksum } from "./preparation/source-checksum.ts";
import type { ShaderSource } from "./types.ts";

const PRODUCER = "@vgpu/wgsl/prepare-v2";

export function prepareShader(
  source: string | Pick<ShaderSource, "wgsl" | "functionExports">,
  path = "<runtime>",
): ShaderSource {
  if (typeof path !== "string" || path.length === 0) {
    throw wgslError("VGPU-SHADER-SOURCE-INVALID", "Invalid prepareShader() path: expected a nonempty string");
  }
  const normalized = normalizePreparationInput(source);

  return {
    version: 2,
    wgsl: normalized.wgsl,
    reflection: serializeReflection(reflectSource(normalized.wgsl, path)),
    sourceChecksum: sourceChecksum(normalized.wgsl),
    producer: PRODUCER,
    ...(normalized.functionExports !== undefined
      ? { functionExports: normalized.functionExports }
      : {}),
  };
}
