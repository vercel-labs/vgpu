import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "./errors.ts";
import { capsuleData } from "./capsule-data.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface CapsuleSpec {
  readonly device: Device;
  readonly radius: number;
  /** Cylinder-section length; total height is height + 2 * radius. */
  readonly height: number;
  readonly radialSegments?: number;
  readonly heightSegments?: number;
  /** Smooth by default; UV V follows meridian distance from bottom to top. */
  readonly shading?: "flat" | "smooth";
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function capsule(spec: CapsuleSpec): Mesh {
  const radialSegments = spec.radialSegments ?? 32;
  const heightSegments = spec.heightSegments ?? 8;
  const shading = spec.shading ?? "smooth";
  validate(spec.radius, spec.height, radialSegments, heightSegments, shading);

  const key = `${spec.radius}|${spec.height}|${radialSegments}|${heightSegments}|${shading}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = capsuleData({ radius: spec.radius, height: spec.height, radialSegments, heightSegments, shading });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.capsule.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.capsule.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
    indexBuffer.write(data.indices);
    const half = spec.height / 2 + spec.radius;
    return Object.freeze({
      vertexBuffer,
      vertexCount: data.vertexCount,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({ min: new Float32Array([-spec.radius, -half, -spec.radius]) as Vec3, max: new Float32Array([spec.radius, half, spec.radius]) as Vec3 }),
      indexBuffer,
      indexCount: data.indices.length,
      indexFormat: "uint16" as const,
      layout: "position-normal-uv" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
    });
  });
}

function validate(radius: number, height: number, radialSegments: number, heightSegments: number, shading: "flat" | "smooth"): void {
  if (radius <= 0) throw invalidUsage("Mesh.capsule", "Radius must be greater than 0.");
  if (height < 0) throw invalidUsage("Mesh.capsule", "Height must be greater than or equal to 0.");
  if (radialSegments < 3) throw invalidUsage("Mesh.capsule", "Radial segments must be at least 3.");
  if (heightSegments < 2) throw invalidUsage("Mesh.capsule", "Height segments must be at least 2.");
  const smoothCount = (radialSegments + 1) * (3 * heightSegments + 1);
  const flatCount = radialSegments * (3 * heightSegments) * 6;
  const vertexCount = shading === "flat" ? flatCount : smoothCount;
  if (vertexCount > 65535) throw invalidUsage("Mesh.capsule", `Segments make ${vertexCount} vertices > uint16 limit 65535; reduce them.`);
}
