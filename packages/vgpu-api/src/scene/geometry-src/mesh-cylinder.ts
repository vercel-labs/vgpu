import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "./errors.ts";
import { cylinderData } from "./cylinder-data.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface CylinderSpec {
  readonly device: Device;
  readonly radius: number;
  readonly radiusTop?: number;
  readonly radiusBottom?: number;
  readonly height: number;
  readonly radialSegments?: number;
  readonly heightSegments?: number;
  readonly openEnded?: boolean;
  readonly thetaStart?: number;
  readonly thetaLength?: number;
  /** Controls side normals only; caps are always flat. Zero-radius caps are omitted. */
  readonly shading?: "flat" | "smooth";
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function cylinder(spec: CylinderSpec): Mesh {
  const radius = spec.radius as number | undefined;
  if (radius !== undefined && spec.radiusTop !== undefined && spec.radiusBottom !== undefined) throw invalidUsage("Mesh.cylinder", "Mesh.cylinder: pass radius OR (radiusTop, radiusBottom), not all three");
  const radialSegments = spec.radialSegments ?? 32;
  const heightSegments = spec.heightSegments ?? 1;
  const openEnded = spec.openEnded ?? false;
  const thetaStart = spec.thetaStart ?? 0;
  const thetaLength = spec.thetaLength ?? Math.PI * 2;
  const shading = spec.shading ?? "smooth";
  const radiusTop = spec.radiusTop ?? radius;
  const radiusBottom = spec.radiusBottom ?? radius;
  validate(radiusTop, radiusBottom, spec.height, radialSegments, heightSegments, openEnded, shading);
  const top = radiusTop ?? 0;
  const bottom = radiusBottom ?? 0;

  const key = `${top}|${bottom}|${spec.height}|${radialSegments}|${heightSegments}|${openEnded}|${thetaStart}|${thetaLength}|${shading}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = cylinderData({ radiusTop: top, radiusBottom: bottom, height: spec.height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength, shading });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.cylinder.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.cylinder.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
    indexBuffer.write(data.indices);
    const boundsRadius = Math.max(top, bottom);
    return Object.freeze({
      vertexBuffer,
      vertexCount: data.vertexCount,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({ min: new Float32Array([-boundsRadius, -spec.height / 2, -boundsRadius]) as Vec3, max: new Float32Array([boundsRadius, spec.height / 2, boundsRadius]) as Vec3 }),
      indexBuffer,
      indexCount: data.indices.length,
      indexFormat: "uint16" as const,
      layout: "position-normal-uv" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
    });
  });
}

function validate(top: number | undefined, bottom: number | undefined, height: number, radialSegments: number, heightSegments: number, openEnded: boolean, shading: "flat" | "smooth"): void {
  if (top === undefined || bottom === undefined) throw invalidUsage("Mesh.cylinder", "Radius is required unless both radiusTop and radiusBottom are provided.");
  if (height <= 0) throw invalidUsage("Mesh.cylinder", "Height must be greater than 0.");
  if (radialSegments < 3) throw invalidUsage("Mesh.cylinder", "Radial segments must be at least 3.");
  if (heightSegments < 1) throw invalidUsage("Mesh.cylinder", "Height segments must be at least 1.");
  if (top < 0 || bottom < 0) throw invalidUsage("Mesh.cylinder", "Resolved radii must be greater than or equal to 0.");
  if (top === 0 && bottom === 0) throw invalidUsage("Mesh.cylinder", "At least one resolved radius must be greater than 0.");
  const capCount = openEnded ? 0 : (top > 0 ? radialSegments + 2 : 0) + (bottom > 0 ? radialSegments + 2 : 0);
  const smoothCount = (radialSegments + 1) * (heightSegments + 1) + capCount;
  const flatCount = radialSegments * heightSegments * 6 + (openEnded ? 0 : (top > 0 ? radialSegments * 3 : 0) + (bottom > 0 ? radialSegments * 3 : 0));
  const vertexCount = shading === "flat" ? flatCount : smoothCount;
  if (vertexCount > 65535) throw invalidUsage("Mesh.cylinder", `Segment counts produce ${vertexCount} vertices, exceeding the uint16 index limit of 65,535. Reduce segment counts.`);
}
