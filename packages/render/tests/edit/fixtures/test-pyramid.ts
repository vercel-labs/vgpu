import type { Device } from "@vgpu/core";
import type { Mesh } from "@vgpu/render";
import { EditableMesh } from "@vgpu/render/edit";

export function makeTestPyramid(device: Device): Mesh {
  const em = EditableMesh.fromArrays({
    positions: new Float32Array([
      0, 0.5, 0,
      -0.5, -0.5, -0.5,
      0.5, -0.5, -0.5,
      0.5, -0.5, 0.5,
      -0.5, -0.5, 0.5,
    ]),
    indices: new Uint32Array([
      0, 1, 2,
      0, 2, 3,
      0, 3, 4,
      0, 4, 1,
      4, 3, 2,
      4, 2, 1,
    ]),
  });
  return em.toRenderMesh({ device });
}
