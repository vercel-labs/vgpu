export class VGPUError extends Error {
  readonly code: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning";
  metadata?: Record<string, unknown>;
  relatedDiagnostics?: readonly { code: string; message: string }[];

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
export function wgslError(code: string, message: string, line = 1, column = 1): WGSLError { return new VGPUError(code, message, line, column); }
export function wgslWarning(code: string, message: string, line = 1, column = 1): WGSLError { return new VGPUError(code, message, line, column, "warning"); }
