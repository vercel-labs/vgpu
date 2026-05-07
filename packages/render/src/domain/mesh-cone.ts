import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "../uniform-pool-internals.ts";
import { coneData } from "./cone-data.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface ConeSpec {
  readonly device: Device;
  readonly radius: number;
  readonly height: number;
  readonly radialSegments?: number;
  readonly heightSegments?: number;
  readonly openEnded?: boolean;
  readonly thetaStart?: number;
  readonly thetaLength?: number;
  /** Controls side normals only; the base cap is always flat. */
  readonly shading?: "flat" | "smooth";
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function cone(spec: ConeSpec): Mesh {
  const radialSegments = spec.radialSegments ?? 32;
  const heightSegments = spec.heightSegments ?? 1;
  const openEnded = spec.openEnded ?? false;
  const thetaStart = spec.thetaStart ?? 0;
  const thetaLength = spec.thetaLength ?? Math.PI * 2;
  const shading = spec.shading ?? "smooth";
  validate(spec.radius, spec.height, radialSegments, heightSegments, openEnded, shading);

  const key = `${spec.radius}|${spec.height}|${radialSegments}|${heightSegments}|${openEnded}|${thetaStart}|${thetaLength}|${shading}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = coneData({ radius: spec.radius, height: spec.height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength, shading });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.cone.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.cone.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
    indexBuffer.write(data.indices);
    return Object.freeze({
      vertexBuffer,
      vertexCount: data.vertexCount,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({ min: new Float32Array([-spec.radius, -spec.height / 2, -spec.radius]) as Vec3, max: new Float32Array([spec.radius, spec.height / 2, spec.radius]) as Vec3 }),
      indexBuffer,
      indexCount: data.indices.length,
      indexFormat: "uint16" as const,
      layout: "position-normal-uv" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
    });
  });
}

function validate(radius: number, height: number, radialSegments: number, heightSegments: number, openEnded: boolean, shading: "flat" | "smooth"): void {
  if (radius <= 0) throw invalidUsage("Mesh.cone", "Radius must be greater than 0.");
  if (height <= 0) throw invalidUsage("Mesh.cone", "Height must be greater than 0.");
  if (radialSegments < 3) throw invalidUsage("Mesh.cone", "Radial segments must be at least 3.");
  if (heightSegments < 1) throw invalidUsage("Mesh.cone", "Height segments must be at least 1.");
  const smoothCount = (radialSegments + 1) * (heightSegments + 1) + (openEnded ? 0 : radialSegments + 2);
  const flatCount = radialSegments * heightSegments * 6 + (openEnded ? 0 : radialSegments * 3);
  const vertexCount = shading === "flat" ? flatCount : smoothCount;
  if (vertexCount > 65535) throw invalidUsage("Mesh.cone", `Segment counts produce ${vertexCount} vertices, exceeding the uint16 index limit of 65,535. Reduce segment counts.`);
}
