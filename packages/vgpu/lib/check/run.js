import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Runs WGSL reflection/validation for a single entry module and dumps JSON.
 */
export async function runCheck(args) {
  const requireValidation = args.includes("--require-validation");
  const [entry] = args.filter((arg) => arg !== "--require-validation");
  if (!entry || entry === "--help" || entry === "-h") {
    return { code: 1, stderr: "Usage: vgpu check <file.wgsl> [--require-validation]\n" };
  }

  const absEntry = resolveEntry(entry);
  try {
    const { resolveShader } = await loadWgslRuntime();
    const options = { entry: absEntry, rootDir: dirname(absEntry) };
    let result;
    let validationError;
    try {
      // Without the flag no `validate` option is passed at all, so the process-wide default
      // ("auto", or VGPU_VALIDATE when set) applies untouched.
      result = await resolveShader({ ...options, ...(requireValidation ? { validate: "require" } : {}) });
    } catch (error) {
      if (!isValidationFailure(error)) throw error;
      // A failing device check must not cost the caller the whole document: re-resolve with
      // validation off so `check` still prints diagnostics + reflection + wgsl, and report the
      // failure inside `validation` instead. Keeps the JSON contract identical whether or not the
      // machine running `check` happens to have a WebGPU device. Exit code stays 1.
      validationError = error;
      try {
        result = await resolveShader({ ...options, validate: "off" });
      } catch {
        // The retry failed for some unrelated reason; the validation failure is the useful one.
        throw error;
      }
    }
    const diagnostics = (result.diagnostics ?? []).map(serializeDiagnostic);
    const payload = {
      schemaVersion: 1,
      entry: absEntry,
      deps: result.deps,
      diagnostics,
      validation: validationError ? failedValidation(requireValidation, validationError) : result.validation,
      reflection: result.reflection,
      wgsl: result.wgsl,
    };
    const failed = Boolean(validationError) || diagnostics.some((diagnostic) => diagnostic.severity === "error");
    return { code: failed ? 1 : 0, stdout: `${JSON.stringify(payload, null, 2)}\n` };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

/**
 * Failures raised *by validation* — an invalid shader, or (in `"require"` mode) a device that could
 * not be acquired. Everything else (resolution, reserved paths, an invalid `VGPU_VALIDATE`) is a
 * hard error: re-resolving with validation off would hide it rather than describe it.
 */
const validationFailureCodes = new Set(["VGPU-WGSL-NAGA-UNKNOWN", "VGPU-WGSL-VALIDATE-NO-DEVICE", "VGPU-WGSL-VALIDATE-ADAPTER-MISSING"]);

function isValidationFailure(error) {
  return Boolean(error && typeof error === "object" && validationFailureCodes.has(error.code));
}

function failedValidation(requireValidation, error) {
  // `--require-validation` always wins over VGPU_VALIDATE, matching resolveShader's precedence.
  const mode = requireValidation ? "require" : process.env.VGPU_VALIDATE || "auto";
  return { mode, attempted: true, ok: false, error: serializeDiagnostic(error) };
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

/**
 * Diagnostics are `Error` instances, whose `message` is not enumerable and would
 * otherwise vanish from the JSON payload.
 */
function serializeDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") return diagnostic;
  const payload = {
    code: diagnostic.code ?? "VGPU-CHECK-UNKNOWN",
    message: diagnostic.message ?? String(diagnostic),
    severity: diagnostic.severity ?? "error",
    line: diagnostic.line ?? null,
    column: diagnostic.column ?? null,
  };
  if (diagnostic.range) payload.range = diagnostic.range;
  if (diagnostic.metadata) payload.metadata = diagnostic.metadata;
  if (diagnostic.relatedDiagnostics) payload.relatedDiagnostics = diagnostic.relatedDiagnostics;
  if (diagnostic.fix) payload.fix = diagnostic.fix;
  if (diagnostic.where) payload.where = diagnostic.where;
  return payload;
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
    if (error.fix) payload.fix = error.fix;
    if (error.where) payload.where = error.where;
    if (error.stack && process.env.VGPU_CHECK_STACK === "1") {
      payload.stack = error.stack;
    }
    return JSON.stringify(payload, null, 2);
  }
  return String(error ?? "Unknown error");
}
