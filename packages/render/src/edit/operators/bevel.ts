import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { add, addQuad, addTri, build, center, edgeVerts, faceVerts, key, mul, p, requireSelection, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface BevelOptions { readonly offset: number; readonly segments?: number; readonly profile?: number; readonly affect?: "edges" | "vertices"; readonly markSharp?: boolean }
export interface BevelResult { readonly mesh: EditableMesh; readonly descendants: { readonly newEdges: ElementSelection; readonly newFaces: ElementSelection }; readonly warnings?: readonly MeshEditWarning[] }

export function bevel(em: EditableMesh, edges: ElementSelection, opts: BevelOptions): BevelResult {
  requireSelection(edges, "edge");
  const selectedEdges = new Set(edges.indices), selectedFaces = incidentFaces(em, selectedEdges);
  const parts: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() }, newFaces: number[] = [], warnings: MeshEditWarning[] = [];
  const k = em.gpu.halfEdgeKernel, markSharp = opts.markSharp ?? true, offset = clamp(opts.offset);
  if ((opts.segments ?? 1) !== 1) warnings.push(new MeshEditWarning("BEVEL_ACUTE_CLAMPED", "Only one bevel segment is supported in this chunk."));
  for (const e of selectedEdges) if (k.edgeFaceB[e] < 0) warnings.push(new MeshEditWarning("NON_MANIFOLD_EDGE_SKIPPED", "Boundary edge was beveled on its one incident face only.", { domain: "edge", index: e }));
  for (let f = 0; f < em.faceCount; f++) {
    const verts = faceVerts(em, f).map((i) => p(em, i));
    if (!selectedFaces.has(f)) { addTri(parts, verts[0], verts[1], verts[2], k.useSmooth[f]); copySharp(em, parts, f); continue; }
    const c = center(verts), inner = verts.map((v) => toward(v, c, offset));
    newFaces.push(addTri(parts, inner[0], inner[1], inner[2], k.useSmooth[f]));
    for (let i = 0; i < 3; i++) {
      const edge = k.faceEdges[f * 3 + i], wasPicked = selectedEdges.has(edge), a = verts[i], b = verts[(i + 1) % 3], ia = inner[i], ib = inner[(i + 1) % 3];
      if (wasPicked) newFaces.push(...addQuad(parts, a, b, ib, ia, 1)); else addTri(parts, a, b, ib, k.useSmooth[f]), addTri(parts, a, ib, ia, k.useSmooth[f]);
      if (markSharp && wasPicked) { parts.sharp.add(key(a, ia)); parts.sharp.add(key(b, ib)); }
      else if (!wasPicked && k.isSharp[edge]) parts.sharp.add(key(a, b));
    }
  }
  const mesh = build(parts), descFaces = selection("face", newFaces); tintNormals(mesh, descFaces.indices); const newEdges = edgesOfFaces(mesh, descFaces.indices);
  const out = { mesh, descendants: { newEdges, newFaces: descFaces } };
  return warnings.length ? { ...out, warnings } : out;
}

function incidentFaces(em: EditableMesh, edges: Set<number>): Set<number> { const k = em.gpu.halfEdgeKernel, out = new Set<number>(); for (const e of edges) { if (k.edgeFaceA[e] >= 0) out.add(k.edgeFaceA[e]); if (k.edgeFaceB[e] >= 0) out.add(k.edgeFaceB[e]); } return out; }
function toward(v: V, c: V, t: number): V { return add(v, mul([c[0] - v[0], c[1] - v[1], c[2] - v[2]], t)); }
function clamp(t: number): number { return Math.max(0, Math.min(0.49, t)); }
function copySharp(em: EditableMesh, m: MeshParts, f: number): void { const k = em.gpu.halfEdgeKernel; for (const e of k.faceEdges.slice(f * 3, f * 3 + 3)) if (k.isSharp[e]) m.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e]))); }
function edgesOfFaces(mesh: EditableMesh, faces: readonly number[]): ElementSelection { const s = new Set(faces), out: number[] = [], k = mesh.gpu.halfEdgeKernel; for (let e = 0; e < k.edgeCount; e++) if (s.has(k.edgeFaceA[e]) || s.has(k.edgeFaceB[e])) out.push(e); return selection("edge", out); }
function tintNormals(mesh: EditableMesh, faces: readonly number[]): void { const n = mesh.gpu.halfEdgeKernel.faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
