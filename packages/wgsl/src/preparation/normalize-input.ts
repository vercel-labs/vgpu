import { wgslError } from "../runtime/errors.ts";
import { isWgslDeclarationIdentifier } from "../runtime/wgsl-identifier-rules.ts";
import type { ShaderFunctionExport, ShaderSource } from "../types.ts";

export interface PreparationInput {
  readonly wgsl: string;
  readonly functionExports?: readonly ShaderFunctionExport[];
}

export function normalizePreparationInput(
  source: string | Pick<ShaderSource, "wgsl" | "functionExports">,
): PreparationInput {
  if (typeof source === "string") return { wgsl: source };
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw invalid("source must be a WGSL string or object");
  }

  const wgsl = ownDataValue(source, "wgsl");
  if (typeof wgsl !== "string") throw invalid("source.wgsl must be a string own data property");

  const functionExports = ownOptionalDataValue(source, "functionExports");
  if (!functionExports.present) return { wgsl };
  if (!Array.isArray(functionExports.value)) {
    throw invalid("source.functionExports must be an array when present");
  }
  return {
    wgsl,
    functionExports: cloneFunctionExports(functionExports.value),
  };
}

function cloneFunctionExports(value: readonly unknown[]): readonly ShaderFunctionExport[] {
  const result: ShaderFunctionExport[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = ownArrayItem(value, index, "source.functionExports");
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw invalid(`source.functionExports[${index}] must be an object`);
    }

    const name = functionExportField(item, "name", index);
    const resolvedName = functionExportField(item, "resolvedName", index);
    const parameterNames = ownDataValue(item, "parameterNames");
    if (!Array.isArray(parameterNames)) {
      throw invalid(`source.functionExports[${index}].parameterNames must be an array`);
    }

    const copiedParameters: string[] = [];
    const seenParameters = new Set<string>();
    for (let parameterIndex = 0; parameterIndex < parameterNames.length; parameterIndex++) {
      const parameter = ownArrayItem(
        parameterNames,
        parameterIndex,
        `source.functionExports[${index}].parameterNames`,
      );
      if (typeof parameter !== "string" || !isWgslDeclarationIdentifier(parameter)) {
        throw invalid(`source.functionExports[${index}].parameterNames[${parameterIndex}] must be a valid WGSL identifier`);
      }
      if (seenParameters.has(parameter)) {
        throw invalid(`source.functionExports[${index}].parameterNames contains duplicate ${parameter}`);
      }
      seenParameters.add(parameter);
      copiedParameters.push(parameter);
    }

    result.push({ name, resolvedName, parameterNames: copiedParameters });
  }
  return result;
}

function functionExportField(
  value: object,
  key: "name" | "resolvedName",
  index: number,
): string {
  const field = ownDataValue(value, key);
  if (typeof field !== "string" || !isWgslDeclarationIdentifier(field)) {
    throw invalid(`source.functionExports[${index}].${key} must be a valid WGSL identifier`);
  }
  return field;
}

function ownArrayItem(value: readonly unknown[], index: number, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  } catch {
    throw invalid(`${path}[${index}] could not be inspected`);
  }
  if (!descriptor || !("value" in descriptor)) {
    throw invalid(`${path}[${index}] must be a present data property`);
  }
  return descriptor.value;
}

function ownDataValue(value: object, key: string): unknown {
  const property = ownOptionalDataValue(value, key);
  return property.present ? property.value : undefined;
}

function ownOptionalDataValue(
  value: object,
  key: string,
): { readonly present: false } | { readonly present: true; readonly value: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw invalid(`source.${key} could not be inspected`);
  }
  if (!descriptor) return { present: false };
  if (!("value" in descriptor)) throw invalid(`source.${key} must be a data property`);
  return { present: true, value: descriptor.value };
}

function invalid(reason: string) {
  return wgslError("VGPU-SHADER-SOURCE-INVALID", `Invalid prepareShader() input: ${reason}`);
}
