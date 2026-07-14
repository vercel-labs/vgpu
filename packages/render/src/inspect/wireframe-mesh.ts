import type { Mesh } from "../mesh-like.ts";

export interface WireframeMesh {
  readonly vertexBuffer: Mesh["vertexBuffer"];
  readonly indexBuffer: GPUBuffer;
  readonly indexFormat: "uint16" | "uint32";
  readonly lineCount: number;
  readonly attributes: Mesh["attributes"];
}
