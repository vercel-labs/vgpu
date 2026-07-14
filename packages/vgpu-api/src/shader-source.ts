import type { ShaderSource } from "@vgpu/wgsl";
import { malformedShaderSourceError } from "./errors.ts";

/** Normalizes public ring-1 shader inputs to raw WGSL. Strings remain first-class; ShaderSource is the loader artifact. */
export function toWgsl(input: string | ShaderSource): string {
  if (typeof input === "string") return input;
  if (!isObject(input)) throw malformedShaderSourceError(input);
  if (!("version" in input)) throw malformedShaderSourceError(input);
  const version = (input as { readonly version: unknown }).version;
  if (version !== 1) throw malformedShaderSourceError(input);
  const wgsl = (input as { readonly wgsl?: unknown }).wgsl;
  if (typeof wgsl !== "string") throw malformedShaderSourceError(input);
  return wgsl;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
