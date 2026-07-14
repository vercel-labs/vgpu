import type { Mesh } from "../mesh-like.ts";
import { MeshEditWarning } from "./warnings.ts";
import { EditableMesh } from "./editable-mesh.ts";
import { sourceOf } from "./edit-source.ts";
import type { EditableMesh as EditableMeshType, ToEditableOptions } from "./types.ts";

export function toEditable(mesh: Mesh, opts?: ToEditableOptions): EditableMeshType {
  return toEditableWithDiagnostics(mesh, opts).mesh;
}

export function toEditableWithDiagnostics(mesh: Mesh, opts?: ToEditableOptions): { readonly mesh: EditableMeshType; readonly warnings: readonly MeshEditWarning[] } {
  const warnings = (mesh.attributes as { tangent?: unknown }).tangent ? [new MeshEditWarning("TANGENTS_STRIPPED", "Tangents are render-layer data and were stripped.")] : [];
  const source = sourceOf(mesh);
  const arrays = source ? { ...source } : boxArrays(mesh);
  return { mesh: EditableMesh.fromArrays({ ...arrays, creaseAngle: opts?.creaseAngle }), warnings };
}

function boxArrays(mesh: Mesh): { positions: Float32Array; indices: Uint32Array } {
  const min = mesh.bbox.min, max = mesh.bbox.max, x0 = min[0], y0 = min[1], z0 = min[2], x1 = max[0], y1 = max[1], z1 = max[2];
  const p = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const f = [1, 2, 6, 1, 6, 5, 4, 7, 3, 4, 3, 0, 3, 7, 6, 3, 6, 2, 4, 0, 1, 4, 1, 5, 4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2];
  return { positions: p, indices: new Uint32Array(f) };
}
