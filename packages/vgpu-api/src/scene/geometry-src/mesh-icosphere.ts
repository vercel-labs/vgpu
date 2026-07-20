import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "./errors.ts";
import { icosphereData } from "./icosphere-data.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface IcosphereSpec {
  readonly device: Device;
  readonly radius: number;
  readonly subdivisions?: number;
  /** Smooth uses radius normals; flat duplicates triangle vertices. UVs use simple spherical projection, with wrap artifacts accepted in v1. */
  readonly shading?: "flat" | "smooth";
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function icosphere(spec: IcosphereSpec): Mesh {
  const subdivisions = spec.subdivisions ?? 2;
  const shading = spec.shading ?? "smooth";
  validate(spec.radius, subdivisions, shading);

  const key = `${spec.radius}|${subdivisions}|${shading}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = icosphereData({ radius: spec.radius, subdivisions, shading });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.icosphere.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.icosphere.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
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
  });
}

function validate(radius: number, subdivisions: number, shading: "flat" | "smooth"): void {
  if (radius <= 0) throw invalidUsage("Mesh.icosphere", "Radius must be greater than 0.");
  if (subdivisions < 0) throw invalidUsage("Mesh.icosphere", "Subdivisions must be greater than or equal to 0.");
  if (subdivisions >= 7) throw invalidUsage("Mesh.icosphere", "Subdivisions must be 6 or less for uint16 indices.");
  const smoothCount = 10 * 4 ** subdivisions + 2;
  const vertexCount = shading === "flat" ? 20 * 4 ** subdivisions * 3 : smoothCount;
  if (vertexCount > 65535) throw invalidUsage("Mesh.icosphere", `Subdivisions make ${vertexCount} vertices > uint16 limit 65535; reduce them.`);
}
