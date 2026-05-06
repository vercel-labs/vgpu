import { Buffer } from "./buffer.ts";
import { bufferUsageFlags } from "./gpuConstants.ts";
import { mockBufferDescriptor } from "./mockGpu.ts";
import { Queue } from "./queue.ts";
import { Readback } from "./readback.ts";
import { ValidationError, type VGPUError } from "./errors.ts";
import type { BufferOptions } from "./types.ts";

export class Device {
  readonly queue: Queue;
  readonly readback: Readback;
  private readonly scopes: VGPUError[][] = [];
  private destroyed = false;

  constructor(readonly gpu: GPUDevice, readonly adapterInfo: GPUAdapterInfo | null = null) {
    this.queue = new Queue(gpu.queue);
    this.readback = new Readback(gpu);
  }

  createBuffer(opts: BufferOptions): Buffer {
    const error = validateBufferOptions(opts);
    if (error) this.captureError(error);
    const desc = error ? mockBufferDescriptor(Math.max(4, opts.size || 4)) : toGPUBufferDescriptor(opts);
    return new Buffer(this, this.gpu.createBuffer(desc), opts);
  }

  pushErrorScope(filter: GPUErrorFilter): void {
    this.scopes.push([]);
    this.gpu.pushErrorScope?.(filter);
  }

  async popErrorScope(): Promise<VGPUError | null> {
    const scope = this.scopes.pop();
    const nativeError = await this.gpu.popErrorScope?.();
    return scope?.[0] ?? nativeErrorToVGPUError(nativeError) ?? null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.readback.destroy();
    this.gpu.destroy();
  }

  dispose(): void {
    this.destroy();
  }

  private captureError(error: VGPUError): void {
    const scope = this.scopes.at(-1);
    if (scope) scope.push(error);
    else throw error;
  }
}

function validateBufferOptions(opts: BufferOptions): ValidationError | null {
  if (!Number.isFinite(opts.size) || opts.size <= 0) {
    return invalidUsage("Buffer size must be greater than zero.");
  }
  if (opts.usage.length === 0) return invalidUsage("Buffer usage must not be empty.");
  return null;
}

function invalidUsage(message: string): ValidationError {
  return new ValidationError({ code: "VGPU-CORE-INVALID-USAGE", message, where: "Device.createBuffer" });
}

function toGPUBufferDescriptor(opts: BufferOptions): GPUBufferDescriptor {
  return { label: opts.label, size: opts.size, usage: bufferUsageFlags(opts.usage) };
}

function nativeErrorToVGPUError(error: GPUError | null | undefined): VGPUError | null {
  if (!error) return null;
  return new ValidationError({ code: "VGPU-CORE-VALIDATION", message: error.message, where: "GPUDevice.popErrorScope", cause: error });
}
