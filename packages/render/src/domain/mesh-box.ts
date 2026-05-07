import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface BoxSpec {
  readonly device: Device;
  readonly size?: number;
}

type Point3 = readonly [number, number, number];
const FLOATS_PER_VERTEX = 6;
const VERTEX_COUNT = 36;
const BYTE_STRIDE = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: BYTE_STRIDE,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
});
const cache = new WeakMap<Device, Map<number, Mesh>>();

export function box(spec: BoxSpec): Mesh {
  const size = spec.size ?? 1;
  return cachedMesh(cache, spec.device, size, () => {
    const vertices = boxVertices(size);
    const vertexBuffer = spec.device.createBuffer({
      label: `mesh.box.size=${size}`,
      size: vertices.byteLength,
      usage: ["vertex", "copy_dst"],
    });
    vertexBuffer.write(vertices);
    const h = size / 2;
    return Object.freeze({
      vertexBuffer,
      vertexCount: VERTEX_COUNT,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({
        min: new Float32Array([-h, -h, -h]) as Vec3,
        max: new Float32Array([h, h, h]) as Vec3,
      }),
      layout: "position-normal" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu }),
    });
  });
}

function boxVertices(size: number): Float32Array<ArrayBuffer> {
  const h = size / 2;
  const data: number[] = [];
  pushFace(data, [h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h], [1, 0, 0]);
  pushFace(data, [-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h], [-1, 0, 0]);
  pushFace(data, [-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h], [0, 1, 0]);
  pushFace(data, [-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h], [0, -1, 0]);
  pushFace(data, [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]);
  pushFace(data, [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
  return new Float32Array(data);
}

function pushFace(data: number[], a: Point3, b: Point3, c: Point3, d: Point3, normal: Point3): void {
  pushVertex(data, a, normal);
  pushVertex(data, b, normal);
  pushVertex(data, c, normal);
  pushVertex(data, a, normal);
  pushVertex(data, c, normal);
  pushVertex(data, d, normal);
}

function pushVertex(data: number[], position: Point3, normal: Point3): void {
  data.push(position[0], position[1], position[2], normal[0], normal[1], normal[2]);
}
