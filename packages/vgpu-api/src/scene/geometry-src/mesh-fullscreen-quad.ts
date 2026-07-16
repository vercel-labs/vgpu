import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface FullscreenQuadSpec {
  readonly device: Device;
}

const VERTEX_COUNT = 6;
const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 12,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
});
const cache = new WeakMap<Device, Mesh>();
const vertices = new Float32Array([
  -1, -1, 0,
  1, -1, 0,
  -1, 1, 0,
  1, -1, 0,
  1, 1, 0,
  -1, 1, 0,
]);

export function fullscreenQuad(spec: FullscreenQuadSpec): Mesh {
  const cached = cache.get(spec.device);
  if (cached) return cached;

  const vertexBuffer = spec.device.createBuffer({
    label: "mesh.fullscreenQuad",
    size: vertices.byteLength,
    usage: ["vertex", "copy_dst"],
  });
  vertexBuffer.write(vertices);

  const mesh = Object.freeze({
    vertexBuffer,
    vertexCount: VERTEX_COUNT,
    attributes: ATTRIBUTES,
    bbox: Object.freeze({
      min: new Float32Array([-1, -1, 0]) as Vec3,
      max: new Float32Array([1, 1, 0]) as Vec3,
    }),
    layout: "position-only" as const,
    gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu }),
  });
  cache.set(spec.device, mesh);
  return mesh;
}
