import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "./errors.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";
import { torusData } from "./torus-data.ts";

export interface TorusSpec {
  readonly device: Device;
  /** Major radius from the origin to the center of the tube. */
  readonly radius: number;
  /** Minor radius of the tube. Must be smaller than radius. */
  readonly tube: number;
  /** Segments around the tube's minor circle. Defaults to 16, matching three.js naming. */
  readonly radialSegments?: number;
  /** Segments around the main ring. Defaults to 32, matching three.js naming. */
  readonly tubularSegments?: number;
  readonly arc?: number;
  readonly shading?: "flat" | "smooth";
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function torus(spec: TorusSpec): Mesh {
  const radialSegments = spec.radialSegments ?? 16;
  const tubularSegments = spec.tubularSegments ?? 32;
  const arc = spec.arc ?? Math.PI * 2;
  const shading = spec.shading ?? "smooth";
  validate(spec.radius, spec.tube, radialSegments, tubularSegments, arc, shading);

  const key = `${spec.radius}|${spec.tube}|${radialSegments}|${tubularSegments}|${arc}|${shading}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = torusData({ radius: spec.radius, tube: spec.tube, radialSegments, tubularSegments, arc, shading });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.torus.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.torus.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
    indexBuffer.write(data.indices);
    const outer = spec.radius + spec.tube;
    return Object.freeze({
      vertexBuffer,
      vertexCount: data.vertexCount,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({ min: new Float32Array([-outer, -spec.tube, -outer]) as Vec3, max: new Float32Array([outer, spec.tube, outer]) as Vec3 }),
      indexBuffer,
      indexCount: data.indices.length,
      indexFormat: "uint16" as const,
      layout: "position-normal-uv" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
    });
  });
}

function validate(radius: number, tube: number, radialSegments: number, tubularSegments: number, arc: number, shading: "flat" | "smooth"): void {
  if (radius <= 0) throw invalidUsage("Mesh.torus", "Radius must be greater than 0.");
  if (tube <= 0) throw invalidUsage("Mesh.torus", "Tube radius must be greater than 0.");
  if (tube >= radius) throw invalidUsage("Mesh.torus", "Tube radius must be smaller than radius.");
  if (radialSegments < 3) throw invalidUsage("Mesh.torus", "Radial segments must be at least 3.");
  if (tubularSegments < 3) throw invalidUsage("Mesh.torus", "Tubular segments must be at least 3.");
  if (arc <= 0) throw invalidUsage("Mesh.torus", "Arc must be greater than 0.");
  const smoothCount = (radialSegments + 1) * (tubularSegments + 1);
  const vertexCount = shading === "flat" ? radialSegments * tubularSegments * 6 : smoothCount;
  if (vertexCount > 65535) throw invalidUsage("Mesh.torus", `Segment counts produce ${vertexCount} vertices, exceeding the uint16 index limit of 65,535. Reduce segment counts.`);
}
