import type { Vec3 } from "wgpu-matrix";

export interface HalfEdgeKernel {
  readonly positions: Float32Array;
  readonly faceVertices: Uint32Array;
  readonly faceEdges: Uint32Array;
  readonly edgeVertexA: Uint32Array;
  readonly edgeVertexB: Uint32Array;
  readonly edgeFaceA: Int32Array;
  readonly edgeFaceB: Int32Array;
  readonly isSharp: Uint8Array;
  readonly useSmooth: Uint8Array;
  readonly faceNormals: Float32Array;
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly faceCount: number;
  iterFaceLoop(face: number): Iterable<number>;
  opposite(edge: number, face: number): number | null;
}

export function makeKernel(args: Omit<HalfEdgeKernel, "iterFaceLoop" | "opposite">): HalfEdgeKernel {
  return {
    ...args,
    iterFaceLoop(face: number) { return args.faceVertices.slice(face * 3, face * 3 + 3); },
    opposite(edge: number, face: number) {
      const a = args.edgeFaceA[edge], b = args.edgeFaceB[edge];
      return a === face && b >= 0 ? b : b === face && a >= 0 ? a : null;
    },
  };
}

export function v3(k: HalfEdgeKernel, i: number): Vec3 {
  return new Float32Array([k.positions[i * 3], k.positions[i * 3 + 1], k.positions[i * 3 + 2]]) as Vec3;
}
