import { isShaderFunctionExport, type ShaderFunctionExport } from "@vgpu/wgsl";
import { adapterError } from "./errors.ts";
import { readFunctionSignature } from "./function-signature.ts";

export type TslExportsSource = string | {
  readonly wgsl: string;
  readonly functionExports?: readonly ShaderFunctionExport[];
};

export function selectFunction(
  source: TslExportsSource,
  name: string,
): ShaderFunctionExport {
  if (typeof source === "string" || !("functionExports" in source)) {
    const signature = readFunctionSignature(
      typeof source === "string" ? source : source.wgsl,
      name,
      false,
    );
    return {
      name,
      resolvedName: signature.name,
      parameterNames: signature.parameters.map((parameter) => parameter.name),
    };
  }

  if (!Array.isArray(source.functionExports)) {
    throw adapterError(
      "VGPU-THREE-TSL-SOURCE-INVALID",
      "functionExports must be an array when present.",
    );
  }
  if (!source.functionExports.every(isShaderFunctionExport)) {
    throw adapterError(
      "VGPU-THREE-TSL-SOURCE-INVALID",
      "functionExports contains malformed metadata.",
    );
  }
  const matches = source.functionExports.filter((item) => item.name === name);
  if (matches.length === 0) {
    throw adapterError(
      "VGPU-THREE-TSL-EXPORT-NOT-FOUND",
      `WGSL module has no direct export named ${name}.`,
    );
  }
  if (matches.length > 1) {
    throw adapterError(
      "VGPU-THREE-TSL-EXPORT-AMBIGUOUS",
      `WGSL module has multiple direct exports named ${name}.`,
    );
  }
  return matches[0]!;
}
