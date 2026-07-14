import { Buffer, type BufferWriteData, type Device } from "@vgpu/core";
import type { StorageAccess, StorageBuffer } from "./gpu.ts";

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

  static create(device: Device, bytes: number, access: StorageAccess, label?: string): RingStorageBuffer {
    const buffer = device.createBuffer({
      size: bytes,
      usage: ["storage", "copy_dst", "copy_src"],
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
}

export function createStorageBuffer(device: Device, bytes: number, access: StorageAccess, label?: string): RingStorageBuffer {
  return RingStorageBuffer.create(device, bytes, access, label);
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
  throw new TypeError("StorageBuffer.write() requiere ArrayBuffer o ArrayBufferView.");
}
