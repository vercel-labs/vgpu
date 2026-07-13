import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
    const { resolveShader } = await loadWgslRuntime();
    const result = await resolveShader({ entry: absEntry, rootDir: dirname(absEntry) });
    const payload = {
      schemaVersion: 1,
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

/**
 * Resolves package-filter invocations back to the workspace root when possible.
 * Outside a pnpm workspace this intentionally falls back to cwd-relative paths.
 */
function resolveEntry(entry) {
  const fromCwd = resolve(process.cwd(), entry);
  if (existsSync(fromCwd)) return fromCwd;
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (!workspaceRoot) return fromCwd;
  const fromWorkspace = resolve(workspaceRoot, entry);
  return existsSync(fromWorkspace) ? fromWorkspace : fromCwd;
}

async function loadWgslRuntime() {
  try {
    return await import("@vgpu/wgsl/runtime");
  } catch (error) {
    if (isMissingWgslRuntime(error)) {
      throw new Error("`vgpu check` requires @vgpu/wgsl to be installed. Install it next to @vgpu/cli, for example: pnpm add -D @vgpu/wgsl");
    }
    throw error;
  }
}

function isMissingWgslRuntime(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      error.code === "ERR_MODULE_NOT_FOUND" &&
      String(error.message ?? "").includes("@vgpu/wgsl"),
  );
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
