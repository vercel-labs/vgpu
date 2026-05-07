import type { Buffer } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import type { VertexLayoutKind } from "./material-factory.ts";

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
  readonly indexBuffer?: Buffer;
  readonly indexCount?: number;
  readonly indexFormat?: "uint16" | "uint32";
  readonly layout?: VertexLayoutKind;
  readonly gpu?: MeshGpu;
}
