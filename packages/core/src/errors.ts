export type VGPUErrorSeverity = "error" | "warning" | "info";

export interface VGPUErrorData {
  readonly code: string;
  readonly message: string;
  readonly severity?: VGPUErrorSeverity;
  readonly fix?: string;
  readonly where?: string;
  readonly cause?: unknown;
}

export class VGPUError extends Error {
  readonly code: string;
  readonly severity: VGPUErrorSeverity;
  readonly fix?: string;
  readonly where?: string;
  override readonly cause?: unknown;

  constructor(data: VGPUErrorData) {
    super(data.message, { cause: data.cause });
    this.name = "VGPUError";
    this.code = data.code;
    this.severity = data.severity ?? "error";
    this.fix = data.fix;
    this.where = data.where;
    this.cause = data.cause;
  }
}

export class ValidationError extends VGPUError {
  constructor(data: Omit<VGPUErrorData, "severity">) {
    super({ ...data, severity: "error" });
    this.name = "ValidationError";
  }
}
