import type { UniformPool } from "./uniform-pool.ts";

export interface UniformPoolOptions {
  readonly capacityBytes?: number;
}

export interface UniformLayout<T> {
  readonly size: number;
  readonly bindings?: readonly GPUBindGroupLayoutEntry[];
  /** Optional layout to share with the pipeline that will consume this slot. */
  readonly bindGroupLayout?: GPUBindGroupLayout;
  encode(value: T, dst: ArrayBuffer, byteOffset: number): void;
}

export interface UniformSlot<T> {
  readonly pool: UniformPool;
  readonly layout: UniformLayout<T>;
  readonly bindGroup: GPUBindGroup;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly gpu: GPUBuffer;
  readonly stride: number;
  push(value: T): number;
  pushBytes(bytes: ArrayBufferView<ArrayBuffer>): number;
}
