import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "../uniform-pool-internals.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";
import { ringData } from "./ring-data.ts";

export interface RingSpec {
  readonly device: Device;
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly segments?: number;
  readonly thetaStart?: number;
  readonly thetaLength?: number;
}

const ATTRIBUTES: VertexAttributes = Object.freeze({
  stride: 32,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
  uv: Object.freeze({ offset: 24, format: "float32x2" as const }),
});
const cache = new WeakMap<Device, Map<string, Mesh>>();

export function ring(spec: RingSpec): Mesh {
  const segments = spec.segments ?? 32;
  const thetaStart = spec.thetaStart ?? 0;
  const thetaLength = spec.thetaLength ?? Math.PI * 2;
  validate(spec.innerRadius, spec.outerRadius, segments);

  const key = `${spec.innerRadius}|${spec.outerRadius}|${segments}|${thetaStart}|${thetaLength}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = ringData({ innerRadius: spec.innerRadius, outerRadius: spec.outerRadius, segments, thetaStart, thetaLength });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.ring.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.ring.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
    indexBuffer.write(data.indices);

    return Object.freeze({
      vertexBuffer,
      vertexCount: data.vertices.length / 8,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({ min: new Float32Array([-spec.outerRadius, 0, -spec.outerRadius]) as Vec3, max: new Float32Array([spec.outerRadius, 0, spec.outerRadius]) as Vec3 }),
      indexBuffer,
      indexCount: data.indices.length,
      indexFormat: "uint16" as const,
      layout: "position-normal-uv" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
    });
  });
}

function validate(innerRadius: number, outerRadius: number, segments: number): void {
  if (innerRadius <= 0) throw invalidUsage("Mesh.ring", "Inner radius must be greater than 0.");
  if (outerRadius <= innerRadius) throw invalidUsage("Mesh.ring", "Outer radius must be greater than inner radius.");
  if (segments < 3) throw invalidUsage("Mesh.ring", "Segments must be at least 3.");
  const vertexCount = 2 * (segments + 1);
  if (vertexCount > 65535) throw invalidUsage("Mesh.ring", `Segment count ${segments} produces ${vertexCount} vertices, exceeding the uint16 index limit of 65,535. Reduce segments.`);
}
