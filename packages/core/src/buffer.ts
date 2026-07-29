import { ValidationError } from "./errors.ts";
import { bufferUsageFlags } from "./gpu-constants.ts";
import { isMockGPUBuffer } from "./mock-gpu-storage.ts";
import { createResourceIdentity, DestroySignal, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "./resource-lifecycle.ts";
import type { Device } from "./device.ts";
import type { BufferOptions, BufferWriteData } from "./types.ts";

type BufferOwnership = "owned" | "external";

export class Buffer {
  private readonly destroySignal = new DestroySignal<Buffer>();
  private readonly identity = createResourceIdentity("buffer");
  private destroyed = false;

  constructor(device: Device, gpu: GPUBuffer, options: BufferOptions);
  constructor(
    private readonly device: Device,
    readonly gpu: GPUBuffer,
    readonly options: BufferOptions,
    private readonly ownership: BufferOwnership = "owned",
  ) { Object.defineProperty(this, "assertUsable", { value: (where: string) => this.#assertUsable(where) }); }

  get resourceIdentity(): ResourceIdentity { return this.identity; }

  onDestroy(cb: ResourceDestroyCallback<Buffer>): UnsubscribeResourceDestroy {
    return this.destroySignal.onDestroy(this, cb);
  }

  #assertUsable(where = "Buffer"): void {
    if (this.destroyed) {
      // Checked before the device: a destroyed buffer is the proximate cause even when its gpu is
      // going down too (`gpu.dispose()` destroys owned buffers and then the device), so naming the
      // buffer beats reporting the device. Keeps the message the native runtime used for this case,
      // since callers and docs already match on it, and adds a code for programmatic handling.
      throw new ValidationError({
        code: "VGPU-BUFFER-DISPOSED",
        message: "Buffer is destroyed.",
        where,
        fix: "Wrap or create a live GPUBuffer before using it.",
      });
    }
    (this.device as unknown as { assertUsable(where: string): void }).assertUsable(where);
  }

  write(data: BufferWriteData, offset = 0): void {
    this.#assertUsable("Buffer.write");
    if (this.ownership === "external") {
      this.validateExternalOperation("write", offset, data.byteLength, "copy_dst");
    }
    try {
      this.device.queue.writeBuffer(this.gpu, offset, data);
    } catch (cause) {
      if (this.ownership !== "external") throw cause;
      throw externalBufferValidation("Buffer.write", "The external GPUBuffer rejected the write operation.", cause);
    }
  }

  async read(byteLength: number, offset = 0): Promise<ArrayBuffer> {
    this.#assertUsable("Buffer.read");
    if (this.ownership === "external") this.validateExternalOperation("read", offset, byteLength, "copy_src");
    try {
      const result = await this.device.readback.read(this.gpu, byteLength, offset);
      this.#assertUsable("Buffer.read");
      return result;
    } catch (cause) {
      if (cause instanceof ValidationError || this.ownership !== "external") throw cause;
      throw externalBufferValidation("Buffer.read", "The external GPUBuffer rejected the read operation.", cause);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroySignal.emit(this);
    if (this.ownership === "owned" && !isMockGPUBuffer(this.gpu)) this.gpu.destroy();
  }

  dispose(): void {
    this.destroy();
  }

  private validateExternalOperation(operation: string, offset: number, byteLength: number, requiredUsage: "copy_src" | "copy_dst"): void {
    const validRange = Number.isSafeInteger(offset) && offset >= 0 && offset % 4 === 0
      && Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength % 4 === 0
      && offset <= this.options.size && byteLength <= this.options.size - offset;
    if (!validRange) {
      throw externalBufferValidation(`Buffer.${operation}`, "External buffer offsets and lengths must be non-negative, 4-byte aligned, and within the buffer size.");
    }
    if ((this.gpu.usage & bufferUsageFlags([requiredUsage])) === 0) {
      throw externalBufferValidation(`Buffer.${operation}`, `External buffer is missing ${requiredUsage.toUpperCase()} usage.`);
    }
  }
}

function externalBufferValidation(where: string, message: string, cause?: unknown): ValidationError {
  return new ValidationError({
    code: "VGPU-EXTERNAL-BUFFER-VALIDATION",
    message,
    where,
    cause,
    fix: "Use a buffer with the required usage flags and an aligned in-range operation.",
  });
}
