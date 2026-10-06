import type { ShaderSource } from "@vgpu/wgsl";
import type { Reflection } from "@vgpu/wgsl/reflect-source";
import { invalidShaderSourceError, unpreparedShaderSourceError, unsupportedShaderSourceVersionError } from "./errors.ts";
import { clonePreparedShaderData, isProvenFrozen } from "./shader-source-snapshot.ts";
import { shaderSourceChecksum } from "./shader-source-checksum.ts";

export interface PreparedShaderSnapshot {
  readonly wgsl: string;
  readonly reflection: Reflection;
  readonly functionExports?: ShaderSource["functionExports"];
}

// Per artifact, weakly keyed and never tied to a device: the checksum of the exact wgsl text last seen (the
// supplied checksum is still compared on every call) and, once the whole consumed graph was proven frozen
// before it was read, the validated snapshot.
const artifacts = new WeakMap<object, { readonly wgsl: string; readonly checksum: string; snapshot?: PreparedShaderSnapshot }>();

/**
 * Copies and validates the complete prepared artifact before renderer state retains any metadata.
 * A deeply frozen artifact is validated once and its snapshot reused; any other artifact is revalidated on each call.
 */
export function snapshotShaderSource(input: ShaderSource): PreparedShaderSnapshot {
  if (typeof input === "string") throw unpreparedShaderSourceError();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidShaderSourceError("shader", "expected a prepared ShaderSource object");
  }
  let known = artifacts.get(input);
  if (known?.snapshot) return known.snapshot;

  // The version is consumed data too: the root must be frozen before it is read.
  const rootFrozen = isProvenFrozen(input);
  const version = ownData(input, "version");
  if (version === 1) throw unpreparedShaderSourceError();
  if (typeof version === "number" && Number.isInteger(version) && version !== 2) {
    throw unsupportedShaderSourceVersionError(version, optionalOwnString(input, "producer"));
  }
  if (version !== 2) throw invalidShaderSourceError("version", "expected integer artifact version 2");

  const [data, graphFrozen] = clonePreparedShaderData(input);
  if (!/^fnv1a64-utf16le-v1:[0-9a-f]{16}$/.test(data.sourceChecksum)) {
    throw invalidShaderSourceError("sourceChecksum", "expected fnv1a64-utf16le-v1 followed by 16 lowercase hexadecimal digits");
  }
  if (known?.wgsl !== data.wgsl) artifacts.set(input, known = { wgsl: data.wgsl, checksum: shaderSourceChecksum(data.wgsl) });
  if (data.sourceChecksum !== known.checksum) {
    throw invalidShaderSourceError("sourceChecksum", "checksum does not match wgsl");
  }

  const snapshot = deepFreeze({
    wgsl: data.wgsl,
    reflection: data.reflection,
    ...(data.functionExports !== undefined ? { functionExports: data.functionExports } : {}),
  });
  if (rootFrozen && graphFrozen) known.snapshot = snapshot;
  return snapshot;
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
