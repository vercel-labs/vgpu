import type { Buffer } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";

export type { Vec3 } from "wgpu-matrix";

export type Mat4 = Float32Array;

export interface VertexAttributes {
  /** Bytes per vertex. */
  readonly stride: number;
  readonly position: { readonly offset: number; readonly format: "float32x3" };
  readonly normal?: { readonly offset: number; readonly format: "float32x3" };
  readonly uv?: { readonly offset: number; readonly format: "float32x2" };
}

export interface MeshGpu {
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer?: GPUBuffer;
}

export interface Mesh {
  readonly vertexBuffer: Buffer;
  readonly vertexCount: number;
  readonly attributes: VertexAttributes;
  readonly bbox: { readonly min: Vec3; readonly max: Vec3 };
  readonly indexBuffer?: Buffer | GPUBuffer;
  readonly indexCount?: number;
  readonly indexFormat?: "uint16" | "uint32";
  readonly layout?: "position-only" | "position-normal" | "position-normal-uv" | "position-uv";
  readonly gpu?: MeshGpu;
}
