import { EditableMesh, type EditableMeshValue } from "@vgpu/render/edit";

export function octahedron(): EditableMeshValue {
  const p = [0, 1, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1, 0, -1, 0];
  const i = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 1];
  return EditableMesh.fromArrays({ positions: new Float32Array(p), indices: new Uint32Array(i) });
}

export function tJunctionVertex(): EditableMeshValue {
  const p = [0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0];
  const i = [0, 1, 2, 0, 3, 4];
  return EditableMesh.fromArrays({ positions: new Float32Array(p), indices: new Uint32Array(i) });
}
