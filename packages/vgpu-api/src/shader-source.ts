import type { ShaderSource } from "@vgpu/wgsl";
import type { Reflection } from "@vgpu/wgsl/reflect-source";
import { invalidShaderSourceError, unpreparedShaderSourceError, unsupportedShaderSourceVersionError } from "./errors.ts";
import { clonePreparedShaderData } from "./shader-source-snapshot.ts";
import { shaderSourceChecksum } from "./shader-source-checksum.ts";

export interface PreparedShaderSnapshot {
  readonly wgsl: string;
  readonly reflection: Reflection;
  readonly functionExports?: ShaderSource["functionExports"];
}

/** Copies and validates the complete prepared artifact before renderer state retains any metadata. */
export function snapshotShaderSource(input: ShaderSource): PreparedShaderSnapshot {
  if (typeof input === "string") throw unpreparedShaderSourceError();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidShaderSourceError("shader", "expected a prepared ShaderSource object");
  }

  const version = ownData(input, "version");
  if (version === 1) throw unpreparedShaderSourceError();
  if (typeof version === "number" && Number.isInteger(version) && version !== 2) {
    throw unsupportedShaderSourceVersionError(version, optionalOwnString(input, "producer"));
  }
  if (version !== 2) throw invalidShaderSourceError("version", "expected integer artifact version 2");

  const data = clonePreparedShaderData(input);
  if (!/^fnv1a64-utf16le-v1:[0-9a-f]{16}$/.test(data.sourceChecksum)) {
    throw invalidShaderSourceError("sourceChecksum", "expected fnv1a64-utf16le-v1 followed by 16 lowercase hexadecimal digits");
  }
  if (data.sourceChecksum !== shaderSourceChecksum(data.wgsl)) {
    throw invalidShaderSourceError("sourceChecksum", "checksum does not match wgsl");
  }

  return deepFreeze({
    wgsl: data.wgsl,
    reflection: data.reflection,
    ...(data.functionExports !== undefined ? { functionExports: data.functionExports } : {}),
  });
}

function ownData(object: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(object, key); }
  catch { throw invalidShaderSourceError(key, "could not read its own property descriptor"); }
  if (!descriptor) throw invalidShaderSourceError(key, "missing required own data property");
  if (!("value" in descriptor)) throw invalidShaderSourceError(key, "accessor properties are not allowed");
  return descriptor.value;
}

function optionalOwnString(object: object, key: string): string | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(object, key); } catch { return undefined; }
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.length > 0
    ? descriptor.value
    : undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
