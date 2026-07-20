import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "./errors.ts";
import { polyhedronData, type PolyhedronSeed } from "./polyhedron-data.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface PolyhedronSpec {
  readonly device: Device;
  readonly radius: number;
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});

export function buildPolyhedronMesh(name: string, spec: PolyhedronSpec, seed: PolyhedronSeed, key: string): Mesh {
  const data = polyhedronData(seed, spec.radius);
  validate(name, spec.radius, data.vertexCount);
  const vertexBuffer = spec.device.createBuffer({ label: `mesh.${name}.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
  vertexBuffer.write(data.vertices);
  const indexBuffer = spec.device.createBuffer({ label: `mesh.${name}.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
  indexBuffer.write(data.indices);
  return Object.freeze({
    vertexBuffer,
    vertexCount: data.vertexCount,
    attributes: ATTRIBUTES,
    bbox: Object.freeze({ min: new Float32Array([-spec.radius, -spec.radius, -spec.radius]) as Vec3, max: new Float32Array([spec.radius, spec.radius, spec.radius]) as Vec3 }),
    indexBuffer,
    indexCount: data.indices.length,
    indexFormat: "uint16" as const,
    layout: "position-normal-uv" as const,
    gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
  });
}

export function validatePolyhedron(name: string, radius: number, vertexCount: number): void {
  validate(name, radius, vertexCount);
}

function validate(name: string, radius: number, vertexCount: number): void {
  if (radius <= 0) throw invalidUsage(`Mesh.${name}`, "Radius must be greater than 0.");
  if (vertexCount > 65535) throw invalidUsage(`Mesh.${name}`, `Geometry has ${vertexCount} vertices > uint16 limit 65535; reduce detail.`);
}
