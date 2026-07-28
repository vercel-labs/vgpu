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
  readonly format?: string;
  readonly binding?: number;
  readonly bindingName?: string;
  readonly resourceName?: string;
  readonly samplerName?: string;
  readonly samplerGroup?: number;
  readonly samplerBinding?: number;
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

export function unsupportedFeaturesError(missing: readonly string[]): VGPUError {
  return new VGPUError({
    code: "VGPU-FEATURE-UNSUPPORTED",
    message: `Adapter does not support requested feature(s): ${missing.map((name) => `"${name}"`).join(", ")}.`,
    fix: "Remove the unsupported name(s) from init({ requiredFeatures: [...] }) or run on an adapter that supports them; gate optional code paths on device.features after init.",
    where: "init",
  });
}

/** Adapters call this before requestDevice so an unsupported requiredFeatures entry fails init with VGPU-FEATURE-UNSUPPORTED instead of a native rejection. An adapter that reports no feature set cannot be pre-checked; native requestDevice validation still applies. */
export function validateRequiredFeatures(supported: { has(name: string): boolean } | undefined, required: readonly GPUFeatureName[] | undefined): void {
  if (!supported) return;
  const missing = (required ?? []).filter((feature) => !supported.has(feature));
  if (missing.length) throw unsupportedFeaturesError(missing);
}
