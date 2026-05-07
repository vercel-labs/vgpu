import type { Shader } from "@vgpu/core";

export interface MaterialParams {
  readonly baseColor: readonly [number, number, number];
  readonly metallic: number;
  readonly roughness: number;
}

export type MaterialUniformValue = number | readonly number[] | Float32Array | Uint32Array | Int32Array;
export type MaterialWriteUniforms<T> = { bivarianceHack(values: T): void }["bivarianceHack"];

export interface MaterialGpu {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup?: GPUBindGroup;
  readonly uniformBuffer?: GPUBuffer;
}

export interface Material {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup?: GPUBindGroup;
  readonly shader: Shader;
  readonly uniformByteSize: number;
  readonly uniformOffsets?: Readonly<Record<string, number>>;
  readonly params: MaterialParams;
  readonly gpu?: MaterialGpu;
  readonly dispose?: () => void;
}
