import { createRequire } from "node:module";
import { wgslError, type WGSLError } from "./errors.ts";

type WebGPUModule = { create(options: string[]): GPU; globals: Record<string, unknown> };
type CompilationMessage = { readonly type?: string; readonly message?: string; readonly lineNum?: number; readonly linePos?: number };
type ShaderModuleWithInfo = GPUShaderModule & { getCompilationInfo?: () => Promise<{ readonly messages: readonly CompilationMessage[] }> };
type ValidationDiagnostic = WGSLError & { range?: unknown; columnPrecise?: boolean; cause?: unknown };

const require = createRequire(import.meta.url);
let devicePromise: Promise<GPUDevice> | undefined;
let gpu: GPU | undefined;

export async function validateWGSL(wgsl: string): Promise<void> {
  if (process.env.VGPU_DOCKER_TEST !== "1") return;
  const device = await validationDevice();
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code: wgsl }) as ShaderModuleWithInfo;
  const info = await module.getCompilationInfo?.();
  const scoped = await device.popErrorScope();
  const message = info?.messages.find((item) => item.type === "error") ?? (scoped ? { message: scoped.message } : undefined);
  if (message) throw diagnostic(wgsl, message, scoped);
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

function validationDevice(): Promise<GPUDevice> { devicePromise ??= createValidationDevice(); return devicePromise; }
async function createValidationDevice(): Promise<GPUDevice> {
  const webgpu = require("webgpu") as WebGPUModule;
  Object.assign(globalThis, webgpu.globals);
  gpu ??= webgpu.create(process.platform === "linux" ? ["backend=opengl"] : []);
  const adapter = await gpu.requestAdapter({ ...(process.platform === "linux" ? { featureLevel: "compatibility" } : {}) } as GPURequestAdapterOptions);
  if (!adapter) throw wgslError("VGPU-WGSL-NAGA-UNKNOWN", "No WebGPU adapter available for WGSL validation");
  return adapter.requestDevice();
}
