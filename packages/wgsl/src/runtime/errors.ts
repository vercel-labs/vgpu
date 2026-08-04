export class VGPUError extends Error {
  readonly code: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning";
  metadata?: Record<string, unknown>;
  relatedDiagnostics?: readonly { code: string; message: string }[];
  /** Actionable remediation text. Forwarded verbatim from the underlying error when there is one. */
  fix?: string;
  /** Coarse origin of the failure (e.g. `"resolveShader"`), mirroring `@vgpu/core`'s `VGPUError`. */
  where?: string;
  override cause?: unknown;

  constructor(code: string, message: string, line = 1, column = 1, severity: "error" | "warning" = "error") {
    super(message);
    this.name = "VGPUError";
    this.code = code;
    this.line = line;
    this.column = column;
    this.severity = severity;
  }
}

export type WGSLError = VGPUError;
export interface VGPUErrorFixData {
  readonly fix?: string;
  readonly where?: string;
  readonly cause?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly severity?: "error" | "warning";
  /** Source position, for the diagnostics that have one (`line`/`column` are 1-based). */
  readonly line?: number;
  readonly column?: number;
}

/**
 * Builds a `WGSLError` carrying remediation metadata (`fix`/`where`/`cause`). Kept separate from
 * `wgslError` so the ~15 existing positional call sites stay untouched.
 */
export function wgslErrorWithFix(code: string, message: string, data: VGPUErrorFixData = {}): WGSLError {
  const error = new VGPUError(code, message, data.line ?? 1, data.column ?? 1, data.severity ?? "error");
  if (data.fix !== undefined) error.fix = data.fix;
  if (data.where !== undefined) error.where = data.where;
  if (data.cause !== undefined) error.cause = data.cause;
  if (data.metadata !== undefined) error.metadata = data.metadata;
  return error;
}
export function wgslError(code: string, message: string, line = 1, column = 1): WGSLError { return new VGPUError(code, message, line, column); }
export function wgslWarning(code: string, message: string, line = 1, column = 1): WGSLError { return new VGPUError(code, message, line, column, "warning"); }
