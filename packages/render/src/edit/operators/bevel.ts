import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { add, addQuad, addTri, build, center, key, mul, p, requireSelection, type MeshParts, type V } from "../operator-utils.ts";
import { unwrapKernel } from "../kernel-handle.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface BevelOptions { readonly offset: number; readonly segments?: number; readonly profile?: number; readonly affect?: "edges" | "vertices"; readonly markSharp?: boolean }
export interface BevelResult { readonly mesh: EditableMesh; readonly newFaces: ElementSelection; readonly originalFaces: ElementSelection; readonly profileLoops: readonly ElementSelection[]; readonly warnings?: readonly MeshEditWarning[] }

export function bevel(em: EditableMesh, edges: ElementSelection, opts: BevelOptions): BevelResult {
  requireSelection(edges, "edge");
  const selectedEdges = new Set(edges.indices), selectedFaces = incidentFaces(em, selectedEdges);
  const parts: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() }, strip: number[] = [], original: number[] = [], profileKeys = new Set<string>(), warnings: MeshEditWarning[] = [];
  const k = unwrapKernel(em.gpu.halfEdgeKernel), markSharp = opts.markSharp ?? true, offset = clamp(opts.offset);
  if ((opts.segments ?? 1) !== 1) warnings.push(new MeshEditWarning("BEVEL_SEGMENTS_CLAMPED", "Only one bevel segment is supported in v1."));
  for (const e of selectedEdges) if (k.edgeFaceB[e] < 0) warnings.push(new MeshEditWarning("NON_MANIFOLD_EDGE_SKIPPED", "Boundary edge was beveled on its one incident face only.", { domain: "edge", index: e }));
  for (let f = 0; f < em.faceCount; f++) {
    const verts = faceVerts3(em, f);
    if (!selectedFaces.has(f)) { addTri(parts, verts[0], verts[1], verts[2], k.useSmooth[f]); copySharp(em, parts, f); continue; }
    const c = center(verts), inner = verts.map((v) => toward(v, c, offset));
    original.push(addTri(parts, inner[0], inner[1], inner[2], k.useSmooth[f]));
    for (let i = 0; i < 3; i++) {
      const edge = k.faceEdges[f * 3 + i], wasPicked = selectedEdges.has(edge), a = verts[i], b = verts[(i + 1) % 3], ia = inner[i], ib = inner[(i + 1) % 3];
      if (wasPicked) strip.push(...addQuad(parts, a, b, ib, ia, 1)); else addTri(parts, a, b, ib, k.useSmooth[f]), addTri(parts, a, ib, ia, k.useSmooth[f]);
      if (wasPicked) { profileKeys.add(key(a, ia)); profileKeys.add(key(b, ib)); }
      if (markSharp && wasPicked) { parts.sharp.add(key(a, b)); parts.sharp.add(key(ia, ib)); }
      else if (!wasPicked && k.isSharp[edge]) parts.sharp.add(key(a, b));
    }
  }
  const mesh = build(parts), newFaces = selection("face", strip), originalFaces = selection("face", original);
  tintNormals(mesh, [...strip, ...original]); const profileLoops = [edgesByKeys(mesh, profileKeys)];
  const out = { mesh, newFaces, originalFaces, profileLoops };
  return warnings.length ? { ...out, warnings } : out;
}

function faceVerts3(em: EditableMesh, f: number): V[] { const k = unwrapKernel(em.gpu.halfEdgeKernel); return Array.from(k.faceVertices.slice(f * 3, f * 3 + 3), (i) => p(em, i)); }
function incidentFaces(em: EditableMesh, edges: Set<number>): Set<number> { const k = unwrapKernel(em.gpu.halfEdgeKernel), out = new Set<number>(); for (const e of edges) { if (k.edgeFaceA[e] >= 0) out.add(k.edgeFaceA[e]); if (k.edgeFaceB[e] >= 0) out.add(k.edgeFaceB[e]); } return out; }
function toward(v: V, c: V, t: number): V { return add(v, mul([c[0] - v[0], c[1] - v[1], c[2] - v[2]], t)); }
function clamp(t: number): number { return Math.max(0, Math.min(0.49, t)); }
function copySharp(em: EditableMesh, m: MeshParts, f: number): void { const k = unwrapKernel(em.gpu.halfEdgeKernel); for (const e of k.faceEdges.slice(f * 3, f * 3 + 3)) if (k.isSharp[e]) m.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e]))); }
function edgesByKeys(mesh: EditableMesh, keys: ReadonlySet<string>): ElementSelection { const out: number[] = [], k = unwrapKernel(mesh.gpu.halfEdgeKernel); for (let e = 0; e < k.edgeCount; e++) if (keys.has(key(p(mesh, k.edgeVertexA[e]), p(mesh, k.edgeVertexB[e])))) out.push(e); return selection("edge", out, true); }
function tintNormals(mesh: EditableMesh, faces: readonly number[]): void { const n = unwrapKernel(mesh.gpu.halfEdgeKernel).faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
