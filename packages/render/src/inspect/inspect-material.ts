import type { Mat4 } from "../domain/index.ts";

export interface InspectMaterial {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly uniformByteSize: number;
  readonly writeUniforms: (buffer: GPUBuffer, offset: number, params: InspectMaterialUniformParams) => void;
}

export interface InspectMaterialUniformParams {
  readonly viewProjectionMatrix: Mat4;
  readonly modelMatrix: Mat4;
  readonly [extra: string]: unknown;
}
