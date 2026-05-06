import { wgslError, type WGSLError } from "./runtime/errors.ts";
import type { ResolvedShader, SourceMap, WGSLAst } from "./types.ts";

// Runtime import errors are native Errors augmented with public structured fields.
type RuntimeImportError = Error & { code: string; severity: "error"; source: "wgsl" };

export function compile(wgsl: string): ResolvedShader {
  if (hasTopLevelImport(wgsl)) throw runtimeImportError();
  const sourceMap: SourceMap = { version: 1, mappings: [] };
  const ast: WGSLAst = {
    version: 1,
    modules: [{ path: "<runtime>", text: wgsl }],
    diagnostics: [],
    sourceMap,
    cacheKey: cacheKey(wgsl),
  };
  return {
    kind: "wgsl",
    wgsl,
    source: { text: wgsl, path: "<runtime>", imports: [] },
    ast,
    sourceMap,
    diagnostics: [],
    cacheKey: ast.cacheKey,
    entryPoints: entryPoints(wgsl),
    stats: { lines: wgsl.split(/\r?\n/).length, bytes: new TextEncoder().encode(wgsl).byteLength, bindGroups: 0 },
  };
}

function cacheKey(wgsl: string): Record<string, string> {
  let hash = 0x811c9dc5;
  for (let i = 0; i < wgsl.length; i++) hash = Math.imul(hash ^ wgsl.charCodeAt(i), 0x01000193);
  return { default: `vgpu-wgsl-1:${(hash >>> 0).toString(16).padStart(8, "0")}` };
}

function entryPoints(wgsl: string): string[] {
  const names: string[] = [];
  const pattern = /@(vertex|fragment|compute)\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of wgsl.matchAll(pattern)) names.push(match[2]!);
  return names;
}

function hasTopLevelImport(wgsl: string): boolean {
  const stripped = wgsl.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trimStart();
  return stripped.startsWith("import ") || stripped.startsWith("import{");
}

function runtimeImportError(): RuntimeImportError {
  // Structured error cast: Error is extended immediately with the public code/severity/source fields below.
  const error = new Error(
    "Runtime WGSL strings cannot contain import statements. Use a build-time loader or @vgpu/wgsl/runtime.",
  ) as RuntimeImportError;
  error.name = "VGPUWGSLRuntimeImportError";
  error.code = "VGPU-WGSL-RUNTIME-IMPORT";
  error.severity = "error";
  error.source = "wgsl";
  return error;
}
