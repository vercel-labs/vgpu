import type { Device } from "@vgpu/core";
import { EditableMesh } from "@vgpu/render/edit";
import type { Mesh as RenderMesh, Vec3 } from "../../src/mesh-like.ts";

export interface Mesh extends RenderMesh {}
export type { Vec3 };

export const Mesh = {
  box,
};

interface BoxSpec {
  readonly device: Device;
  readonly size?: number;
}

function box(spec: BoxSpec): RenderMesh {
  const h = (spec.size ?? 1) / 2;
  return EditableMesh.fromArrays({
    positions: new Float32Array([
      -h, -h, -h,
      h, -h, -h,
      h, h, -h,
      -h, h, -h,
      -h, -h, h,
      h, -h, h,
      h, h, h,
      -h, h, h,
    ]),
    indices: new Uint32Array([
      1, 2, 6, 1, 6, 5,
      4, 7, 3, 4, 3, 0,
      3, 7, 6, 3, 6, 2,
      4, 0, 1, 4, 1, 5,
      4, 5, 6, 4, 6, 7,
      1, 0, 3, 1, 3, 2,
    ]),
  }).toRenderMesh({ device: spec.device });
}
