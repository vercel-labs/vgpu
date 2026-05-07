import { MeshEditError } from "../errors.ts";
import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addTri, build, center, key, p, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface GridFillOptions { readonly spanMode?: "auto" | number }
export interface GridFillResult { readonly mesh: EditableMesh; readonly descendants: { readonly newFaces: ElementSelection }; readonly warnings?: readonly MeshEditWarning[] }

export function gridFill(em: EditableMesh, boundary: ElementSelection, opts: GridFillOptions = {}): GridFillResult {
  requireLoop(boundary);
  const verts = loopVertices(em, boundary.indices), ps = verts.map((v) => p(em, v)), c = center(ps), parts = copyMesh(em), warnings: MeshEditWarning[] = [];
  if (verts.length % 2 !== 0) warnings.push(new MeshEditWarning("FILL_NON_PLANAR_BOUNDARY", "Grid fill boundary has odd length; triangulated fan was used."));
  if (typeof opts.spanMode === "number" && opts.spanMode < 1) throw new MeshEditError({ code: "DEGENERATE_RESULT" });
  warnings.push(new MeshEditWarning("GRID_FILL_TRIANGULATED", `Triangle-only editable meshes represent ${opts.spanMode ?? "auto"} span grid fill as deterministic triangles.`));
  const start = parts.faces.length;
  for (let i = 0; i < ps.length; i++) addTri(parts, ps[i], ps[(i + 1) % ps.length], c, 1);
  const mesh = build(parts), faces = selection("face", range(start, parts.faces.length)); tint(mesh, range(0, mesh.faceCount));
  const out = { mesh, descendants: { newFaces: faces } };
  return { ...out, warnings };
}

function requireLoop(sel: ElementSelection): void {
  if (sel.domain !== "edge") throw new MeshEditError({ code: "WRONG_DOMAIN" });
  if (sel.count === 0) throw new MeshEditError({ code: "EMPTY_SELECTION" });
  if (!sel.ordered) throw new MeshEditError({ code: "NOT_ORDERED" });
}

function loopVertices(em: EditableMesh, edges: readonly number[]): number[] {
  const k = em.gpu.halfEdgeKernel, out = [k.edgeVertexA[edges[0]], k.edgeVertexB[edges[0]]];
  for (let i = 1; i < edges.length; i++) {
    const a = k.edgeVertexA[edges[i]], b = k.edgeVertexB[edges[i]], tail = out[out.length - 1];
    if (a === tail) out.push(b); else if (b === tail) out.push(a); else if (a === out[0]) out.unshift(b); else if (b === out[0]) out.unshift(a); else throw new MeshEditError({ code: "AMBIGUOUS_TOPOLOGY" });
  }
  if (out[0] === out[out.length - 1]) out.pop();
  if (out.length < 3) throw new MeshEditError({ code: "DEGENERATE_RESULT" });
  return out;
}

function copyMesh(em: EditableMesh): MeshParts {
  const k = em.gpu.halfEdgeKernel, m: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() };
  for (let f = 0; f < em.faceCount; f++) addTri(m, p(em, k.faceVertices[f * 3]), p(em, k.faceVertices[f * 3 + 1]), p(em, k.faceVertices[f * 3 + 2]), k.useSmooth[f]);
  for (let e = 0; e < em.edgeCount; e++) if (k.isSharp[e]) m.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e])));
  return m;
}

function range(a: number, b: number): number[] { return Array.from({ length: b - a }, (_, i) => a + i); }
function tint(em: EditableMesh, faces: readonly number[]): void { const n = em.gpu.halfEdgeKernel.faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
