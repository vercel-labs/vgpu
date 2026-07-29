import { Buffer, type BufferUsageName, type BufferWriteData, type Device } from "@vgpu/core";
import type { StorageAccess, StorageBuffer, StorageOptions } from "./api-types.ts";
import type { Gpu } from "./kernel.ts";
import { liveKernel, ownResource } from "./live-kernel.ts";

/**
 * Storage buffer owned by this gpu: `read()`/`write()` from the host, bindable from any shader.
 *
 * `access` accepts the shorthand string or the options bag; `{ indirect: true }` adds the "indirect"
 * usage so the buffer can supply GPU-read draw/dispatch arguments. The buffer is destroyed by
 * `gpu.dispose()` — or earlier, by hand, through the internal handle.
 */
export function storage(gpu: Gpu, bytes: number, access: StorageAccess | StorageOptions = "read-write"): StorageBuffer {
  const kernel = liveKernel(gpu, "storage");
  const opts = typeof access === "string" ? { access } : access;
  const buffer = createStorageBuffer(kernel.device, bytes, opts.access ?? "read-write", undefined, opts.indirect ?? false);
  return ownResource(kernel, buffer, (owned) => owned.destroy(), (cb) => { buffer.onDestroy(cb); });
}

/**
 * Ring-1 StorageBuffer facade backed by a core Buffer.
 *
 * @internal
 */
export class RingStorageBuffer implements StorageBuffer {
  readonly size: number;
  readonly access: StorageAccess;
  readonly buffer: Buffer;

  constructor(buffer: Buffer, access: StorageAccess) {
    this.buffer = buffer;
    this.access = access;
    this.size = buffer.options.size;
  }

  static create(device: Device, bytes: number, access: StorageAccess, label?: string, indirect = false): RingStorageBuffer {
    const usage: readonly BufferUsageName[] = indirect ? ["storage", "copy_dst", "copy_src", "indirect"] : ["storage", "copy_dst", "copy_src"];
    const buffer = device.createBuffer({
      size: bytes,
      usage,
      label,
    });
    return new RingStorageBuffer(buffer, access);
  }

  read(): Promise<ArrayBuffer> {
    return this.buffer.read(this.size);
  }

  write(data: BufferSource, offset = 0): void {
    this.buffer.write(asWriteData(data), offset);
  }

  get gpu(): GPUBuffer {
    return this.buffer.gpu;
  }

  get resourceIdentity() {
    return this.buffer.resourceIdentity;
  }

  onDestroy(cb: (buffer: Buffer) => void) {
    return this.buffer.onDestroy(cb);
  }

  /** Frees the GPU allocation. Idempotent; bind groups holding it are invalidated through the buffer's destroy signal. */
  destroy(): void {
    this.buffer.destroy();
  }
}

export function createStorageBuffer(device: Device, bytes: number, access: StorageAccess, label?: string, indirect = false): RingStorageBuffer {
  return RingStorageBuffer.create(device, bytes, access, label, indirect);
}

/**
 * Wraps an existing core buffer as an internal StorageBuffer facade.
 *
 * @internal
 */
export function wrapStorageBuffer(buffer: Buffer, access: StorageAccess): RingStorageBuffer {
  return new RingStorageBuffer(buffer, access);
}

function asWriteData(data: BufferSource): BufferWriteData {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data;
  throw new TypeError("StorageBuffer.write() requires ArrayBuffer or ArrayBufferView.");
}
