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

// Keep entry-point discovery local to the browser-facing compile path: importing the runtime
// scanner or reflection would make the root export exceed its client bundle budget.
function entryPoints(wgsl: string): string[] {
  const names: string[] = [];
  const read = tokenReader(wgsl);

  for (let token = read(); token !== undefined; token = read()) {
    let hasStage = false;
    while (token === "@") {
      if (/^(vertex|fragment|compute)$/.test(read()!)) hasStage = true;

      token = read();
      if (token === "(") {
        if (!skipParentheses(read)) return names;
        token = read();
      }
    }

    if (token === "fn") {
      const name = read();
      token = read();
      if (hasStage && token === "(" && name && IDENTIFIER.test(name)) names.push(name);
    }
    skipDeclaration(read, token);
  }
  return names;
}

// XIDC is Unicode's XID_Continue alias (including underscore); aliases keep the client bundle small.
const IDENTIFIER = /[_\p{XID_Start}]\p{XIDC}*/uy;
type TokenReader = () => string | undefined;

function tokenReader(source: string): TokenReader {
  let index = 0;
  return () => {
    while (index < source.length) {
      const start = index;

      // WGSL uses Pattern_White_Space, whose Unicode alias is Pat_WS.
      if (/\p{Pat_WS}/u.test(source[start]!)) {
        index++;
        continue;
      }
      if (source.startsWith("//", start)) {
        // Leave the line ending for blankspace handling; EOF stays exhausted.
        while (index < source.length && !/[\n-\r\u0085\u2028\u2029]/.test(source[index]!)) index++;
        continue;
      }
      if (source.startsWith("/*", start)) {
        index += 2;
        let depth = 1;
        while (index < source.length && depth > 0) {
          if (source.startsWith("/*", index)) {
            depth++;
            index += 2;
          } else if (source.startsWith("*/", index)) {
            depth--;
            index += 2;
          } else {
            index++;
          }
        }
        continue;
      }
      IDENTIFIER.lastIndex = start;
      const identifier = IDENTIFIER.exec(source);
      if (identifier) {
        index = IDENTIFIER.lastIndex;
        return identifier[0];
      }

      index++;
      return source[start];
    }
    return undefined;
  };
}

function skipParentheses(read: TokenReader): boolean {
  let depth = 1;
  for (let token = read(); token !== undefined; token = read()) {
    if (token === "(") depth++;
    else if (token === ")" && --depth === 0) return true;
  }
  return false;
}

function skipDeclaration(read: TokenReader, first: string | undefined): void {
  let braces = 0;

  for (let token = first; token !== undefined; token = read()) {
    if (token === "{") braces++;
    else if (token === "}" && braces > 0 && --braces === 0) return;
    else if (token === ";" && braces === 0) return;
  }
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
