import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "./errors.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";
import { planeData } from "./plane-data.ts";

export interface PlaneSpec {
  readonly device: Device;
  readonly width?: number;
  readonly height?: number;
  readonly widthSegments?: number;
  readonly heightSegments?: number;
  /** Exposed for API consistency; plane normals are always fixed to +Y. */
  readonly shading?: "flat" | "smooth";
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function plane(spec: PlaneSpec): Mesh {
  const width = spec.width ?? 1;
  const height = spec.height ?? 1;
  const widthSegments = spec.widthSegments ?? 1;
  const heightSegments = spec.heightSegments ?? 1;
  const shading = spec.shading ?? "flat";
  validate(width, height, widthSegments, heightSegments);

  const key = `${width}|${height}|${widthSegments}|${heightSegments}|${shading}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = planeData({ width, height, widthSegments, heightSegments });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.plane.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.plane.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
    indexBuffer.write(data.indices);

    return Object.freeze({
      vertexBuffer,
      vertexCount: data.vertices.length / 8,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({ min: new Float32Array([-width / 2, 0, -height / 2]) as Vec3, max: new Float32Array([width / 2, 0, height / 2]) as Vec3 }),
      indexBuffer,
      indexCount: data.indices.length,
      indexFormat: "uint16" as const,
      layout: "position-normal-uv" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
    });
  });
}

function validate(width: number, height: number, widthSegments: number, heightSegments: number): void {
  if (width <= 0) throw invalidUsage("Mesh.plane", "Width must be greater than 0.");
  if (height <= 0) throw invalidUsage("Mesh.plane", "Height must be greater than 0.");
  if (widthSegments < 1) throw invalidUsage("Mesh.plane", "Width segments must be at least 1.");
  if (heightSegments < 1) throw invalidUsage("Mesh.plane", "Height segments must be at least 1.");
  const vertexCount = (widthSegments + 1) * (heightSegments + 1);
  if (vertexCount > 65535) throw invalidUsage("Mesh.plane", `Segments ${widthSegments}x${heightSegments} make ${vertexCount} vertices > uint16 limit 65535; reduce them.`);
}
