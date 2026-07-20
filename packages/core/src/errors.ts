export type VGPUErrorSeverity = "error" | "warning" | "info";

export interface VGPUErrorDetail {
  readonly drawLabel?: string;
  readonly group?: number;
  readonly signature?: string;
  readonly stage?: "vertex" | "fragment";
  readonly entryPoint?: string;
  readonly count?: number;
  readonly limit?: number;
  readonly bindings?: readonly { readonly name: string; readonly group: number; readonly binding: number }[];
}

export interface VGPUErrorData {
  readonly code: string;
  readonly message: string;
  readonly severity?: VGPUErrorSeverity;
  readonly fix?: string;
  readonly where?: string;
  readonly cause?: unknown;
  readonly detail?: VGPUErrorDetail;
}

export class VGPUError extends Error {
  readonly code: string;
  readonly severity: VGPUErrorSeverity;
  readonly fix?: string;
  readonly where?: string;
  override readonly cause?: unknown;
  readonly detail?: VGPUErrorDetail;

  constructor(data: VGPUErrorData) {
    super(data.message, { cause: data.cause });
    this.name = "VGPUError";
    this.code = data.code;
    this.severity = data.severity ?? "error";
    this.fix = data.fix;
    this.where = data.where;
    this.cause = data.cause;
    this.detail = data.detail;
  }
}

export class ValidationError extends VGPUError {
  constructor(data: Omit<VGPUErrorData, "severity">) {
    super({ ...data, severity: "error" });
    this.name = "ValidationError";
  }
}
