import { wgslError, wgslErrorWithFix, type WGSLError } from "./errors.ts";
import { acquireValidationDevice, releaseValidationDevice } from "./validation-device.ts";

type CompilationMessage = { readonly type?: string; readonly message?: string; readonly lineNum?: number; readonly linePos?: number };
type ShaderModuleWithInfo = GPUShaderModule & { getCompilationInfo?: () => Promise<{ readonly messages: readonly CompilationMessage[] }> };
type ValidationDiagnostic = WGSLError & { range?: unknown; columnPrecise?: boolean; cause?: unknown };

export type ValidateMode = "off" | "auto" | "require";
/**
 * What actually happened when validation ran. `attempted: false` means the caller asked for
 * `"off"`; `attempted: true, ok: false` with a `skipped` payload means a device was unavailable and
 * the mode was `"auto"` (a real WGSL diagnostic throws instead of being reported here).
 */
export type ValidationOutcome = { attempted: boolean; ok: boolean; skipped?: { code: string; message: string; fix?: string } };

const deviceErrorCodes = new Set(["VGPU-WGSL-VALIDATE-ADAPTER-MISSING", "VGPU-WGSL-VALIDATE-NO-DEVICE"]);
let warned = false;

export async function validateWGSL(wgsl: string, mode: "auto" | "require"): Promise<ValidationOutcome> {
  let device: GPUDevice;
  try {
    device = await acquireValidationDevice();
  } catch (error) {
    releaseValidationDevice();
    const failure = error as WGSLError | undefined;
    if (!failure || !deviceErrorCodes.has(failure.code)) throw error;
    if (mode === "require") throw error;
    warnValidationSkippedOnce(failure);
    return { attempted: true, ok: false, skipped: { code: failure.code, message: failure.message, ...(failure.fix ? { fix: failure.fix } : {}) } };
  }
  try {
    return await serializeOnDevice(async () => {
      device.pushErrorScope("validation");
      const module = device.createShaderModule({ code: wgsl }) as ShaderModuleWithInfo;
      const info = await module.getCompilationInfo?.();
      const scoped = await device.popErrorScope();
      const message = info?.messages.find((item) => item.type === "error") ?? (scoped ? { message: scoped.message } : undefined);
      if (message) throw diagnostic(wgsl, message, scoped);
      return { attempted: true, ok: true };
    });
  } finally {
    releaseValidationDevice();
  }
}

let deviceQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs the error-scope-bracketed part of validation one at a time.
 *
 * Error scopes are a stack *per device*, and every concurrent validation shares the one memoized
 * device, so interleaved push/pop pairs pop each other's scopes: two `resolveShader` calls racing
 * meant a valid shader could be rejected with its neighbour's diagnostic, or an invalid one pass
 * because its error was popped by the neighbour. Only this section is serialized — the device lease
 * is taken outside it, so a queued validation can never be waiting on a lease its predecessor holds.
 */
function serializeOnDevice<T>(run: () => Promise<T>): Promise<T> {
  // `then(run, run)` because a failed predecessor must not stop the queue: a rejected validation is
  // an ordinary outcome here (an invalid shader), not a reason to strand everyone behind it.
  const next = deviceQueue.then(run, run);
  deviceQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Reads the process-wide default validate mode. An explicit `validate` option always wins over it.
 */
export function resolveDefaultValidateMode(): ValidateMode {
  const raw = process.env.VGPU_VALIDATE;
  if (raw === undefined || raw === "") return "auto";
  if (raw === "off" || raw === "auto" || raw === "require") return raw;
  throw wgslErrorWithFix("VGPU-WGSL-VALIDATE-ENV-INVALID", `Invalid VGPU_VALIDATE=${JSON.stringify(raw)}; expected "off", "auto", or "require".`, {
    fix: "Unset VGPU_VALIDATE or set it to off, auto, or require.",
    where: "resolveShader",
  });
}

function warnValidationSkippedOnce(error: WGSLError): void {
  if (warned) return;
  warned = true;
  console.error(`vgpu: WGSL validation skipped (${error.code}): ${error.message}${error.fix ? `\n  fix: ${error.fix}` : ""}\n  Set validate: "require" (or VGPU_VALIDATE=require) to make this a hard failure, or validate: "off" to silence it.`);
}

/** @internal test-only — clears the once-per-process skip warning. */
export function __resetValidationWarnOnceForTests(): void {
  warned = false;
}

function diagnostic(wgsl: string, message: CompilationMessage, cause: unknown): ValidationDiagnostic {
  const { line, column } = position(message);
  const mapped = mapGenerated(wgsl, line, column);
  const error = wgslError("VGPU-WGSL-NAGA-UNKNOWN", message.message ?? "WGSL validation failed", mapped.line, mapped.column) as ValidationDiagnostic;
  error.range = { file: mapped.file, start: { line: mapped.line, column: mapped.column } };
  error.columnPrecise = mapped.columnPrecise;
  error.cause = cause;
  if (!mapped.columnPrecise) {
    error.relatedDiagnostics = [{ code: "VGPU-WGSL-COL-APPROX", message: "column position is approximate; this line contained substituted identifiers" }];
    error.metadata = { ...(error.metadata ?? {}), codes: ["VGPU-WGSL-COL-APPROX"] };
  }
  return error;
}

function position(message: CompilationMessage): { line: number; column: number } {
  if (message.lineNum) return { line: message.lineNum, column: message.linePos || 1 };
  const match = message.message?.match(/:(\d+):(\d+)\s+error|line\s+(\d+),\s*column\s+(\d+)/i);
  return { line: Number(match?.[1] ?? match?.[3] ?? 1), column: Number(match?.[2] ?? match?.[4] ?? 1) };
}

function mapGenerated(wgsl: string, line: number, column: number): { file: string; line: number; column: number; columnPrecise: boolean } {
  let file = "<generated>", sourceLine = 0;
  const lines = wgsl.split(/\r?\n/);
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const header = lines[i]!.match(/^\/\/ vgsl-module: (.+)$/);
    if (header) { file = header[1]!.split(/[\\/]/).pop() ?? header[1]!; sourceLine = 0; continue; }
    sourceLine++;
  }
  const text = lines[line - 1] ?? "";
  const columnPrecise = text.includes("_vgsl_") ? !text.slice(0, Math.max(0, column - 1)).includes("_vgsl_") : true;
  return { file, line: Math.max(1, sourceLine), column, columnPrecise };
}
