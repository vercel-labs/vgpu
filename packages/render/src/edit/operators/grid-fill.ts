import { MeshEditError } from "../errors.ts";
import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addTri, build, center, copyMesh, loopVertices, p, range, requireLoop, tint } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface GridFillOptions { readonly spanMode?: "auto" | number }
export interface GridFillResult { readonly mesh: EditableMesh; readonly newFaces: ElementSelection; readonly warnings?: readonly MeshEditWarning[] }

export function gridFill(em: EditableMesh, boundary: ElementSelection, opts: GridFillOptions = {}): GridFillResult {
  requireLoop(boundary);
  const verts = loopVertices(em, boundary.indices), ps = verts.map((v) => p(em, v)), c = center(ps), parts = copyMesh(em), warnings: MeshEditWarning[] = [];
  if (verts.length % 2 !== 0) warnings.push(new MeshEditWarning("FILL_NON_PLANAR_BOUNDARY", "Grid fill boundary has odd length; triangulated fan was used."));
  if (typeof opts.spanMode === "number" && opts.spanMode < 1) throw new MeshEditError({ code: "DEGENERATE_RESULT" });
  warnings.push(new MeshEditWarning("GRID_FILL_TRIANGULATED", `Triangle-only editable meshes represent ${opts.spanMode ?? "auto"} span grid fill as deterministic triangles.`));
  const start = parts.faces.length;
  for (let i = 0; i < ps.length; i++) addTri(parts, ps[i], ps[(i + 1) % ps.length], c, 1);
  const mesh = build(parts), faces = selection("face", range(start, parts.faces.length)); tint(mesh, range(0, mesh.faceCount));
  return { mesh, newFaces: faces, warnings };
}
