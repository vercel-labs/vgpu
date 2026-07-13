import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveShader } from "@vgpu/wgsl/runtime";

/**
 * Runs WGSL reflection/validation for a single entry module and dumps JSON.
 */
export async function runCheck(args) {
  const [entry] = args;
  if (!entry || entry === "--help" || entry === "-h") {
    return { code: 1, stderr: "Usage: vgpu check <file.wgsl>\n" };
  }

  const absEntry = resolveEntry(entry);
  try {
    const result = await resolveShader({ entry: absEntry, rootDir: dirname(absEntry) });
    const payload = {
      entry: absEntry,
      deps: result.deps,
      diagnostics: result.diagnostics,
      reflection: result.reflection,
      wgsl: result.wgsl,
    };
    return { code: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function resolveEntry(entry) {
  const fromCwd = resolve(process.cwd(), entry);
  if (existsSync(fromCwd)) return fromCwd;
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (!workspaceRoot) return fromCwd;
  const fromWorkspace = resolve(workspaceRoot, entry);
  return existsSync(fromWorkspace) ? fromWorkspace : fromCwd;
}

function findWorkspaceRoot(startDir) {
  for (let dir = startDir;; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function formatError(error) {
  if (error && typeof error === "object") {
    const payload = {
      code: error.code ?? "VGPU-CHECK-UNKNOWN",
      message: error.message ?? String(error),
      severity: error.severity ?? "error",
      line: error.line ?? null,
      column: error.column ?? null,
      metadata: error.metadata,
      relatedDiagnostics: error.relatedDiagnostics,
    };
    if (error.range) payload.range = error.range;
    if (error.stack && process.env.VGPU_CHECK_STACK === "1") {
      payload.stack = error.stack;
    }
    return JSON.stringify(payload, null, 2);
  }
  return String(error ?? "Unknown error");
}
