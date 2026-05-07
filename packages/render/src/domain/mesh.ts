import type { Buffer, Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";

export interface VertexAttributes {
  /** Bytes per vertex. */
  readonly stride: number;
  readonly position: { readonly offset: number; readonly format: "float32x3" };
  readonly normal: { readonly offset: number; readonly format: "float32x3" };
}

export interface Mesh {
  readonly vertexBuffer: Buffer;
  readonly vertexCount: number;
  readonly attributes: VertexAttributes;
  readonly bbox: { readonly min: Vec3; readonly max: Vec3 };
}

export interface BoxSpec {
  readonly device: Device;
  readonly size?: number;
}

const FLOATS_PER_VERTEX = 6;
const VERTEX_COUNT = 36;
const BYTE_STRIDE = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: BYTE_STRIDE,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
});
const cache = new WeakMap<Device, Map<number, Mesh>>();

export namespace Mesh {
  export function box(spec: BoxSpec): Mesh {
    const size = spec.size ?? 1;
    let meshes = cache.get(spec.device);
    if (!meshes) {
      meshes = new Map<number, Mesh>();
      cache.set(spec.device, meshes);
    }

    const cached = meshes.get(size);
    if (cached) return cached;

    const vertices = boxVertices(size);
    const vertexBuffer = spec.device.createBuffer({
      label: `mesh.box.size=${size}`,
      size: vertices.byteLength,
      usage: ["vertex", "copy_dst"],
    });
    vertexBuffer.write(vertices);

    const h = size / 2;
    const mesh = Object.freeze({
      vertexBuffer,
      vertexCount: VERTEX_COUNT,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({
        min: new Float32Array([-h, -h, -h]) as Vec3,
        max: new Float32Array([h, h, h]) as Vec3,
      }),
    });
    meshes.set(size, mesh);
    return mesh;
  }
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

function pushFace(
  data: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
  normal: readonly [number, number, number],
): void {
  pushVertex(data, a, normal);
  pushVertex(data, b, normal);
  pushVertex(data, c, normal);
  pushVertex(data, a, normal);
  pushVertex(data, c, normal);
  pushVertex(data, d, normal);
}

function pushVertex(
  data: number[],
  position: readonly [number, number, number],
  normal: readonly [number, number, number],
): void {
  data.push(position[0], position[1], position[2], normal[0], normal[1], normal[2]);
}
