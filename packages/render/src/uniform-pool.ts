import { VGPUError, type Device } from "@vgpu/core";
import {
  copyDstUsage,
  defaultCapacityBytes,
  defaultMaxUniformBindingSize,
  defaultMinOffsetAlignment,
  deviceLimit,
  invalidUsage,
  roundUp,
  shaderVisibility,
  uniformUsage,
  viewBytes,
} from "./uniform-pool-internals.ts";
import type { UniformLayout, UniformPoolOptions, UniformSlot } from "./uniform-pool-types.ts";

export class UniformPool {
  readonly minOffsetAlignment: number;
  readonly capacityBytes: number;
  readonly maxUniformBindingSize: number;
  readonly cpuMirror: ArrayBuffer;
  readonly gpu: GPUBuffer;
  private readonly bytes: Uint8Array;
  private head = 0;
  private hasUnflushedPushes = false;
  private isDisposed = false;

  constructor(readonly device: Device, opts: UniformPoolOptions = {}) {
    this.capacityBytes = opts.capacityBytes ?? defaultCapacityBytes;
    this.minOffsetAlignment = deviceLimit(device, "minUniformBufferOffsetAlignment", defaultMinOffsetAlignment);
    this.maxUniformBindingSize = deviceLimit(device, "maxUniformBufferBindingSize", defaultMaxUniformBindingSize);
    this.cpuMirror = new ArrayBuffer(this.capacityBytes);
    this.bytes = new Uint8Array(this.cpuMirror);
    this.gpu = device.gpu.createBuffer({ label: "vgpu UniformPool", size: this.capacityBytes, usage: uniformUsage | copyDstUsage });
  }

  get usedBytes(): number { return this.head; }
  get disposed(): boolean { return this.isDisposed; }

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
      throw invalidUsage("UniformSlot.pushBytes", `Uniform bytes must match layout size ${slot.layout.size}.`);
    }
    return this.write(slot.layout.size, slot.stride, (offset) => this.bytes.set(viewBytes(bytes), offset));
  }

  beginFrame(_frameIndex: number): void {
    this.assertUsable("UniformPool.beginFrame");
    this.head = 0;
    this.hasUnflushedPushes = false;
  }

  endFrame(): void {
    this.assertUsable("UniformPool.endFrame");
    if (this.hasUnflushedPushes) this.device.gpu.queue.writeBuffer(this.gpu, 0, this.cpuMirror, 0, this.head);
    this.hasUnflushedPushes = false;
  }

  assertReadyForSubmit(where: string): void {
    this.assertUsable(where);
    if (!this.hasUnflushedPushes) return;
    throw invalidUsage(where, "UniformPool has unflushed pushes; call endFrame() before submitting.");
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.gpu.destroy();
  }

  private assertOwnsSlot(slot: UniformSlot<unknown>, where: string): void {
    if (slot.pool === this) return;
    throw invalidUsage(where, "UniformSlot was allocated by a different UniformPool.");
  }

  private write(layoutSize: number, stride: number, encode: (byteOffset: number) => void): number {
    this.assertUsable("UniformSlot.push");
    this.assertCanPush(layoutSize, stride);
    const offset = this.head;
    encode(offset);
    this.head += stride;
    this.hasUnflushedPushes = true;
    return offset;
  }

  private assertCanPush(layoutSize: number, stride: number): void {
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
    throw invalidUsage(where, "UniformPool has been disposed.");
  }
}

class PoolSlot<T> implements UniformSlot<T> {
  readonly bindGroup: GPUBindGroup;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly gpu: GPUBuffer;

  constructor(readonly pool: UniformPool, readonly layout: UniformLayout<T>, readonly stride: number) {
    this.gpu = pool.gpu;
    this.bindGroupLayout = layout.bindGroupLayout ?? pool.device.gpu.createBindGroupLayout({
      label: "UniformPool.slot.bgl",
      entries: layout.bindings ?? [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: layout.size } }],
    });
    this.bindGroup = pool.device.gpu.createBindGroup({
      label: "UniformPool.slot.bg",
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.gpu, offset: 0, size: stride } }],
    });
  }

  push(value: T): number { return this.pool.push(this, value); }
  pushBytes(bytes: ArrayBufferView<ArrayBuffer>): number { return this.pool.pushBytes(this, bytes); }
}
