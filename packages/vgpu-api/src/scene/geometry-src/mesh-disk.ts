import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { invalidUsage } from "../../core/uniform-pool-internals.ts";
import { diskData } from "./disk-data.ts";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh, VertexAttributes } from "./mesh-types.ts";

export interface DiskSpec {
  readonly device: Device;
  readonly radius: number;
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

export function disk(spec: DiskSpec): Mesh {
  const segments = spec.segments ?? 32;
  const thetaStart = spec.thetaStart ?? 0;
  const thetaLength = spec.thetaLength ?? Math.PI * 2;
  validate(spec.radius, segments);

  const key = `${spec.radius}|${segments}|${thetaStart}|${thetaLength}`;
  return cachedMesh(cache, spec.device, key, () => {
    const data = diskData({ radius: spec.radius, segments, thetaStart, thetaLength });
    const vertexBuffer = spec.device.createBuffer({ label: `mesh.disk.vertices.${key}`, size: data.vertices.byteLength, usage: ["vertex", "copy_dst"] });
    vertexBuffer.write(data.vertices);
    const indexBuffer = spec.device.createBuffer({ label: `mesh.disk.indices.${key}`, size: data.indices.byteLength, usage: ["index", "copy_dst"] });
    indexBuffer.write(data.indices);

    return Object.freeze({
      vertexBuffer,
      vertexCount: data.vertices.length / 8,
      attributes: ATTRIBUTES,
      bbox: Object.freeze({ min: new Float32Array([-spec.radius, 0, -spec.radius]) as Vec3, max: new Float32Array([spec.radius, 0, spec.radius]) as Vec3 }),
      indexBuffer,
      indexCount: data.indices.length,
      indexFormat: "uint16" as const,
      layout: "position-normal-uv" as const,
      gpu: Object.freeze({ vertexBuffer: vertexBuffer.gpu, indexBuffer: indexBuffer.gpu }),
    });
  });
}

function validate(radius: number, segments: number): void {
  if (radius <= 0) throw invalidUsage("Mesh.disk", "Radius must be greater than 0.");
  if (segments < 3) throw invalidUsage("Mesh.disk", "Segments must be at least 3.");
  const vertexCount = segments + 2;
  if (vertexCount > 65535) throw invalidUsage("Mesh.disk", `Segment count ${segments} produces ${vertexCount} vertices, exceeding the uint16 index limit of 65,535. Reduce segments.`);
}
