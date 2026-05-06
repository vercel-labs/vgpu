import { VGPUError, type Device } from "@vgpu/core";
import type { UniformLayout, UniformPoolOptions, UniformSlot } from "./uniform-pool-types.ts";

const defaultCapacityBytes = 4 * 1024 * 1024;
const defaultMinOffsetAlignment = 256;
const defaultMaxUniformBindingSize = 64 * 1024;
const uniformUsage = 64;
const copyDstUsage = 8;

export class UniformPool {
  readonly minOffsetAlignment: number;
  readonly capacityBytes: number;
  readonly maxUniformBindingSize: number;
  readonly cpuMirror: ArrayBuffer;
  readonly gpu: GPUBuffer;
  private readonly bytes: Uint8Array;
  private head = 0;
  private flushed = false;
  private isDisposed = false;

  constructor(readonly device: Device, opts: UniformPoolOptions = {}) {
    this.capacityBytes = opts.capacityBytes ?? defaultCapacityBytes;
    this.minOffsetAlignment = deviceLimit(device, "minUniformBufferOffsetAlignment", defaultMinOffsetAlignment);
    this.maxUniformBindingSize = deviceLimit(device, "maxUniformBufferBindingSize", defaultMaxUniformBindingSize);
    this.cpuMirror = new ArrayBuffer(this.capacityBytes);
    this.bytes = new Uint8Array(this.cpuMirror);
    this.gpu = device.gpu.createBuffer({ label: "vgpu UniformPool", size: this.capacityBytes, usage: uniformUsage | copyDstUsage });
  }

  get usedBytes(): number {
    return this.head;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  alloc<T>(layout: UniformLayout<T>): UniformSlot<T> {
    this.assertUsable("UniformPool.alloc");
    this.assertLayoutFits(layout);
    return new PoolSlot(this, layout, roundUp(layout.size, this.minOffsetAlignment));
  }

  push<T>(slot: UniformSlot<T>, value: T): number {
    this.assertOwnsSlot(slot, "UniformPool.push");
    return this.write(slot.layout.size, slot.stride, (offset) => slot.layout.encode(value, this.cpuMirror, offset));
  }

  pushBytes(slot: UniformSlot<unknown>, bytes: ArrayBufferView<ArrayBuffer>): number {
    this.assertOwnsSlot(slot, "UniformPool.pushBytes");
    if (bytes.byteLength !== slot.layout.size) {
      throw new VGPUError({
        code: "VGPU-CORE-INVALID-USAGE",
        message: `Uniform bytes must match layout size ${slot.layout.size}.`,
        where: "UniformSlot.pushBytes",
      });
    }
    return this.write(slot.layout.size, slot.stride, (offset) => this.bytes.set(viewBytes(bytes), offset));
  }

  beginFrame(_frameIndex: number): void {
    this.assertUsable("UniformPool.beginFrame");
    this.head = 0;
    this.flushed = false;
  }

  endFrame(): void {
    this.assertUsable("UniformPool.endFrame");
    // TODO(uniform-pool): GPU upload wires up when first real consumer lands
    this.flushed = true;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.gpu.destroy();
  }

  private assertOwnsSlot(slot: UniformSlot<unknown>, where: string): void {
    if (slot.pool === this) return;
    throw new VGPUError({
      code: "VGPU-CORE-INVALID-USAGE",
      message: "UniformSlot was allocated by a different UniformPool.",
      where,
    });
  }

  private write(layoutSize: number, stride: number, encode: (byteOffset: number) => void): number {
    this.assertUsable("UniformSlot.push");
    this.assertCanPush(layoutSize, stride);
    const offset = this.head;
    encode(offset);
    this.head += stride;
    return offset;
  }

  private assertCanPush(layoutSize: number, stride: number): void {
    if (this.flushed) {
      throw new VGPUError({
        code: "VGPU-CORE-UNIFORM-POOL-PUSH-AFTER-FLUSH",
        message: "Call UniformPool.beginFrame() before pushing more uniform data after endFrame().",
        where: "UniformSlot.push",
      });
    }
    if (this.head + stride <= this.capacityBytes) return;
    throw new VGPUError({
      code: "VGPU-UNIFORM-POOL-OVERFLOW",
      message: `UniformPool capacity ${this.capacityBytes} bytes is exceeded by a ${layoutSize}-byte layout.`,
      where: "UniformSlot.push",
    });
  }

  private assertLayoutFits(layout: UniformLayout<unknown>): void {
    if (layout.size <= this.capacityBytes && layout.size <= this.maxUniformBindingSize) return;
    throw new VGPUError({
      code: "VGPU-UNIFORM-LAYOUT-OVERSIZED",
      message: `Uniform layout size ${layout.size} bytes is too large for this pool.`,
      where: "UniformPool.alloc",
    });
  }

  private assertUsable(where: string): void {
    if (!this.isDisposed) return;
    throw new VGPUError({ code: "VGPU-CORE-INVALID-USAGE", message: "UniformPool has been disposed.", where });
  }
}

class PoolSlot<T> implements UniformSlot<T> {
  readonly bindGroup: GPUBindGroup | null = null;
  readonly bindGroupLayout: GPUBindGroupLayout | null = null;
  readonly gpu: GPUBuffer;
  constructor(readonly pool: UniformPool, readonly layout: UniformLayout<T>, readonly stride: number) {
    this.gpu = pool.gpu;
  }
  push(value: T): number { return this.pool.push(this, value); }
  pushBytes(bytes: ArrayBufferView<ArrayBuffer>): number { return this.pool.pushBytes(this, bytes); }
}

function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function deviceLimit(device: Device, key: keyof GPUSupportedLimits, fallback: number): number {
  const limits = (device.gpu as GPUDevice & { readonly limits?: Partial<Record<keyof GPUSupportedLimits, number>> }).limits;
  return limits?.[key] ?? fallback;
}

function viewBytes(view: ArrayBufferView<ArrayBuffer>): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
