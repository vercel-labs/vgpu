import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "../uniform-pool-internals.ts";
import type { Mesh, VertexAttributes } from "./mesh.ts";
import { sphereData } from "./sphere-data.ts";

export interface SphereSpec {
  readonly device: Device;
  readonly radius?: number;
  readonly widthSegments?: number;
  readonly heightSegments?: number;
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function sphere(spec: SphereSpec): Mesh {
  const radius = spec.radius ?? 0.5;
  const widthSegments = spec.widthSegments ?? 32;
  const heightSegments = spec.heightSegments ?? 16;
  validate(radius, widthSegments, heightSegments);

  let meshes = cache.get(spec.device);
  if (!meshes) {
    meshes = new Map<string, Mesh>();
    cache.set(spec.device, meshes);
  }

  const key = `${radius}|${widthSegments}|${heightSegments}`;
  const cached = meshes.get(key);
  if (cached) return cached;

  const data = sphereData({ radius, widthSegments, heightSegments });
  const vertexBuffer = spec.device.createBuffer({ label: `mesh.sphere.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
  vertexBuffer.write(data.vertices);
  const indexBuffer = spec.device.createBuffer({ label: `mesh.sphere.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
  indexBuffer.write(data.indices);

  const mesh = Object.freeze({
    vertexBuffer,
    vertexCount: data.vertices.length / 8,
    attributes: ATTRIBUTES,
    bbox: Object.freeze({
      min: new Float32Array([-radius, -radius, -radius]) as Vec3,
      max: new Float32Array([radius, radius, radius]) as Vec3,
    }),
    indexBuffer,
    indexCount: data.indices.length,
    indexFormat: "uint16" as const,
    layout: "position-normal-uv" as const,
    gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
  });
  meshes.set(key, mesh);
  return mesh;
}

function validate(radius: number, widthSegments: number, heightSegments: number): void {
  if (radius <= 0) throw invalidUsage("Mesh.sphere", "Radius must be greater than 0.");
  if (widthSegments < 3) throw invalidUsage("Mesh.sphere", "Width segments must be at least 3.");
  if (heightSegments < 2) throw invalidUsage("Mesh.sphere", "Height segments must be at least 2.");
}
