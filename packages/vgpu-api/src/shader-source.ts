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

// Validated snapshots of artifacts whose whole consumed graph was frozen before it was read. Weak keys:
// an entry lives only as long as its artifact, and nothing here is tied to a device.
const immutableSnapshots = new WeakMap<object, PreparedShaderSnapshot>();
// The checksum of the exact wgsl text last seen on each artifact; the supplied checksum is still compared every time.
const checksums = new WeakMap<object, { readonly wgsl: string; readonly checksum: string }>();

/**
 * Copies and validates the complete prepared artifact before renderer state retains any metadata.
 * A deeply frozen artifact is validated once and its snapshot reused; any other artifact is revalidated on each call.
 */
export function snapshotShaderSource(input: ShaderSource): PreparedShaderSnapshot {
  if (typeof input === "string") throw unpreparedShaderSourceError();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidShaderSourceError("shader", "expected a prepared ShaderSource object");
  }
  const cached = immutableSnapshots.get(input);
  if (cached) return cached;

  // The version is consumed data too: the root must be frozen before it is read.
  const rootFrozen = isProvenFrozen(input);
  const version = ownData(input, "version");
  if (version === 1) throw unpreparedShaderSourceError();
  if (typeof version === "number" && Number.isInteger(version) && version !== 2) {
    throw unsupportedShaderSourceVersionError(version, optionalOwnString(input, "producer"));
  }
  if (version !== 2) throw invalidShaderSourceError("version", "expected integer artifact version 2");

  const { data, immutable } = clonePreparedShaderData(input);
  if (!/^fnv1a64-utf16le-v1:[0-9a-f]{16}$/.test(data.sourceChecksum)) {
    throw invalidShaderSourceError("sourceChecksum", "expected fnv1a64-utf16le-v1 followed by 16 lowercase hexadecimal digits");
  }
  let known = checksums.get(input);
  if (known?.wgsl !== data.wgsl) checksums.set(input, known = { wgsl: data.wgsl, checksum: shaderSourceChecksum(data.wgsl) });
  if (data.sourceChecksum !== known.checksum) {
    throw invalidShaderSourceError("sourceChecksum", "checksum does not match wgsl");
  }

  const snapshot = deepFreeze({
    wgsl: data.wgsl,
    reflection: data.reflection,
    ...(data.functionExports !== undefined ? { functionExports: data.functionExports } : {}),
  });
  if (rootFrozen && immutable) immutableSnapshots.set(input, snapshot);
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
