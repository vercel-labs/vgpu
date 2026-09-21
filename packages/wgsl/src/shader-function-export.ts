import type { ShaderFunctionExport } from "./types.ts";
import { isWgslDeclarationIdentifier } from "./runtime/wgsl-identifier-rules.ts";

export function isShaderFunctionExport(
  value: unknown,
): value is ShaderFunctionExport {
  if (typeof value !== "object" || value === null) return false;

  try {
    const { name, resolvedName, parameterNames } = value as Record<string, unknown>;
    return isIdentifier(name)
      && isIdentifier(resolvedName)
      && areValidParameterNames(parameterNames);
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && isWgslDeclarationIdentifier(value);
}

function areValidParameterNames(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;

  const names = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const parameterName = value[index];
    if (!isIdentifier(parameterName) || names.has(parameterName)) return false;
    names.add(parameterName);
  }
  return true;
}
