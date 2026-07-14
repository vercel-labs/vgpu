import type { Device, Buffer } from "@vgpu/core";
import type { Mesh, VertexAttributes } from "../mesh-like.ts";
import type { HalfEdgeKernel } from "./half-edge-kernel.ts";
import { attachSource } from "./edit-source.ts";

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 24,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
});

export function bakeRenderMesh(k: HalfEdgeKernel, device: Device): Mesh {
  const data: number[] = [];
  for (let f = 0; f < k.faceCount; f++) for (let c = 0; c < 3; c++) {
    const v = k.faceVertices[f * 3 + c] * 3, n = f * 3;
    data.push(k.positions[v], k.positions[v + 1], k.positions[v + 2], k.faceNormals[n], k.faceNormals[n + 1], k.faceNormals[n + 2]);
  }
  const vertices = new Float32Array(data);
  const vertexBuffer = device.createBuffer({ label: "editable-mesh", size: vertices.byteLength, usage: ["vertex", "copy_dst"] });
  vertexBuffer.write(vertices);
  const mesh = { vertexBuffer, vertexCount: vertices.length / 6, attributes: ATTRIBUTES, bbox: bounds(k.positions) } as Mesh;
  attachSource(mesh, { positions: new Float32Array(k.positions), indices: new Uint32Array(k.faceVertices), sharpEdges: new Uint8Array(k.isSharp), useSmooth: new Uint8Array(k.useSmooth) });
  return Object.freeze(mesh);
}

function bounds(p: Float32Array): { readonly min: Float32Array; readonly max: Float32Array } {
  const min = new Float32Array([Infinity, Infinity, Infinity]), max = new Float32Array([-Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[i + a]); max[a] = Math.max(max[a], p[i + a]); }
  return Object.freeze({ min, max });
}
