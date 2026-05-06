import type { UniformPool } from "./uniform-pool.ts";

export interface UniformPoolOptions {
  readonly capacityBytes?: number;
}

export interface UniformLayout<T> {
  readonly size: number;
  readonly bindings?: readonly GPUBindGroupLayoutEntry[];
  encode(value: T, dst: ArrayBuffer, byteOffset: number): void;
}

export interface UniformSlot<T> {
  readonly pool: UniformPool;
  readonly layout: UniformLayout<T>;
  readonly bindGroup: GPUBindGroup | null;
  readonly bindGroupLayout: GPUBindGroupLayout | null;
  readonly gpu: GPUBuffer;
  readonly stride: number;
  push(value: T): number;
  pushBytes(bytes: ArrayBufferView<ArrayBuffer>): number;
}
