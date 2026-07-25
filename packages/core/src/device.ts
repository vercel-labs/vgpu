import { compile } from "@vgpu/wgsl";
import { Buffer } from "./buffer.ts";
import { bufferUsageFlags } from "./gpu-constants.ts";
import { mockBufferDescriptor } from "./mock-gpu.ts";
import { Queue } from "./queue.ts";
import { Shader, type ShaderInput } from "./shader.ts";
import { Texture, toGPUTextureDescriptor } from "./texture.ts";
import { Readback } from "./readback.ts";
import { ValidationError, type VGPUError } from "./errors.ts";
import type { BufferOptions, BufferUsageName, TextureOptions } from "./types.ts";

export interface DeviceOptions {
  /** True when the adapter requested WebGPU featureLevel "compatibility". */
  readonly isCompatibilityMode?: boolean;
}

type DeviceOwnership = "owned" | "external";
type DeviceState = "alive" | "disposed" | "lost";

export class Device {
  readonly queue: Queue;
  /** @internal — use Buffer.read() and Texture.read() instead */
  readonly readback: Readback;
  readonly isCompatibilityMode: boolean;
  private readonly scopes: VGPUError[][] = [];
  private readonly ownership: DeviceOwnership;
  private state: DeviceState = "alive";
  private lossInfo: GPUDeviceLostInfo | undefined;
  private observeLoss = true;

  constructor(gpu: GPUDevice, adapterInfo?: GPUAdapterInfo | null, options?: DeviceOptions);
  constructor(
    readonly gpu: GPUDevice,
    readonly adapterInfo: GPUAdapterInfo | null = null,
    ownershipOrOptions: DeviceOwnership | DeviceOptions = "owned",
    options: DeviceOptions = {},
  ) {
    Object.defineProperty(this, "assertUsable", { value: (where: string) => this.#assertUsable(where) });
    this.ownership = typeof ownershipOrOptions === "string" ? ownershipOrOptions : "owned";
    const opts = typeof ownershipOrOptions === "string" ? options : ownershipOrOptions;
    this.isCompatibilityMode = opts.isCompatibilityMode ?? false;
    this.queue = new (Queue as unknown as new (gpu: GPUQueue, guard: (where: string) => void) => Queue)(gpu.queue, (where) => this.#assertUsable(where));
    this.readback = new Readback(gpu);
    const lost = gpu.lost;
    if (lost && typeof (lost as PromiseLike<GPUDeviceLostInfo>).then === "function") {
      void Promise.resolve(lost).then((info) => {
        if (!this.observeLoss || this.state !== "alive") return;
        this.lossInfo = info;
        this.state = "lost";
      }, () => undefined);
    }
  }

  get limits(): GPUSupportedLimits {
    this.#assertUsable("Device.limits");
    return this.gpu.limits;
  }

  get features(): GPUSupportedFeatures {
    this.#assertUsable("Device.features");
    return this.gpu.features;
  }

  createShader(input: ShaderInput): Shader {
    this.#assertUsable("Device.createShader");
    const resolved = typeof input === "string" ? compile(input) : input;
    return new Shader(this.gpu.createShaderModule({ code: resolved.wgsl }), resolved);
  }

  createTexture(opts: TextureOptions): Texture {
    this.#assertUsable("Device.createTexture");
    return new Texture(this, this.gpu.createTexture(toGPUTextureDescriptor(opts)), opts);
  }

  createBuffer(opts: BufferOptions): Buffer {
    this.#assertUsable("Device.createBuffer");
    const error = validateBufferOptions(opts);
    if (error) this.captureError(error);
    const desc = error ? mockBufferDescriptor(Math.max(4, opts.size || 4)) : toGPUBufferDescriptor(opts);
    return new Buffer(this, this.gpu.createBuffer(desc), opts);
  }

  /** Wraps a caller-owned GPUBuffer without taking ownership of its native lifetime. */
  wrapBuffer(buffer: GPUBuffer): Buffer {
    this.#assertUsable("Device.wrapBuffer");
    if (!isExternalBufferShape(buffer)) {
      throw new ValidationError({
        code: "VGPU-EXTERNAL-BUFFER-INVALID",
        message: "Device.wrapBuffer requires a GPUBuffer with finite size and usage properties.",
        where: "Device.wrapBuffer",
        fix: "Pass a live GPUBuffer created for this GPUDevice.",
      });
    }
    const options: BufferOptions = {
      size: buffer.size,
      usage: bufferUsageNames(buffer.usage),
      ...(buffer.label ? { label: buffer.label } : {}),
    };
    return new (Buffer as unknown as new (device: Device, gpu: GPUBuffer, options: BufferOptions, ownership: "external") => Buffer)(this, buffer, options, "external");
  }

  pushErrorScope(filter: GPUErrorFilter): void {
    this.#assertUsable("Device.pushErrorScope");
    this.scopes.push([]);
    this.gpu.pushErrorScope?.(filter);
  }

  async popErrorScope(): Promise<VGPUError | null> {
    this.#assertUsable("Device.popErrorScope");
    const scope = this.scopes.pop();
    const nativeError = await this.gpu.popErrorScope?.();
    this.#assertUsable("Device.popErrorScope");
    return scope?.[0] ?? nativeErrorToVGPUError(nativeError) ?? null;
  }

  #assertUsable(where: string): void {
    if (this.state === "alive") return;
    if (this.state === "disposed") {
      throw new ValidationError({
        code: "VGPU-DEVICE-DISPOSED",
        message: "The GPU device wrapper has been disposed.",
        where,
        fix: "Create a new Gpu instance before performing more work.",
      });
    }
    const reason = this.lossInfo?.reason;
    const nativeMessage = this.lossInfo?.message;
    throw new ValidationError({
      code: "VGPU-DEVICE-LOST",
      message: `The GPU device was lost${reason ? ` (${reason})` : ""}${nativeMessage ? `: ${nativeMessage}` : "."}`,
      where,
      cause: this.lossInfo,
    });
  }

  destroy(): void {
    if (this.state === "disposed") return;
    const wasLost = this.state === "lost";
    this.state = "disposed";
    this.observeLoss = false;
    this.scopes.length = 0;
    this.readback.destroy();
    if (this.ownership === "owned" && !wasLost) this.gpu.destroy();
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
  if (!Number.isFinite(opts.size) || opts.size <= 0) return invalidUsage("Buffer size must be greater than zero.");
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

function isExternalBufferShape(value: unknown): value is GPUBuffer {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const buffer = value as Partial<GPUBuffer>;
  return Number.isSafeInteger(buffer.size) && (buffer.size ?? -1) >= 0
    && Number.isSafeInteger(buffer.usage) && (buffer.usage ?? -1) >= 0
    && typeof buffer.destroy === "function";
}

const bufferUsages: readonly BufferUsageName[] = ["map_read", "map_write", "copy_src", "copy_dst", "index", "vertex", "uniform", "storage", "indirect", "query_resolve"];
function bufferUsageNames(flags: GPUBufferUsageFlags): BufferUsageName[] {
  return bufferUsages.filter((usage) => (flags & bufferUsageFlags([usage])) !== 0);
}
