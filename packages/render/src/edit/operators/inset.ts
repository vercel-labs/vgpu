import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { add, addQuad, addTri, build, center, faceVerts, key, mul, normal, p, requireSelection, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

import { unwrapKernel } from "../kernel-handle.ts";
export interface InsetOptions { readonly thickness: number; readonly depth?: number; readonly individual?: boolean }
export interface InsetResult { readonly mesh: EditableMesh; readonly insetFaces: ElementSelection; readonly boundaryFaces: ElementSelection; readonly rimEdges: ElementSelection; readonly warnings?: readonly MeshEditWarning[] }

export function inset(em: EditableMesh, faces: ElementSelection, opts: InsetOptions): InsetResult {
  requireSelection(faces, "face");
  const selected = new Set(faces.indices), parts: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() };
  const inner: number[] = [], boundary: number[] = [], warnings: MeshEditWarning[] = [], source = unwrapKernel(em.gpu.halfEdgeKernel);
  for (let f = 0; f < em.faceCount; f++) if (!selected.has(f)) {
    const v = faceVerts(em, f).map((i) => p(em, i)); addTri(parts, v[0], v[1], v[2], source.useSmooth[f]);
    for (const e of source.faceEdges.slice(f * 3, f * 3 + 3)) if (source.isSharp[e]) parts.sharp.add(key(p(em, source.edgeVertexA[e]), p(em, source.edgeVertexB[e])));
  }
  for (const f of faces.indices) {
    const verts = faceVerts(em, f).map((i) => p(em, i)), c = center(verts), n = normal(verts), t = clamp(opts.thickness);
    if (t !== opts.thickness) warnings.push(new MeshEditWarning("INSET_OVERLAP_CLAMPED", "Inset thickness was clamped before faces crossed.", { domain: "face", index: f }));
    const ins = verts.map((v) => add(toward(v, c, t), n, opts.depth ?? 0));
    inner.push(addTri(parts, ins[0], ins[1], ins[2], source.useSmooth[f]));
    for (let i = 0; i < 3; i++) {
      const q = addQuad(parts, verts[i], verts[(i + 1) % 3], ins[(i + 1) % 3], ins[i], source.useSmooth[f]);
      boundary.push(...q);
      const e = source.faceEdges[f * 3 + i]; if (source.isSharp[e]) parts.sharp.add(key(verts[i], verts[(i + 1) % 3]));
    }
  }
  const mesh = build(parts), rimEdges = edgeSelectionOf(mesh, boundary);
  const out = { mesh, insetFaces: selection("face", inner), boundaryFaces: selection("face", boundary), rimEdges };
  return warnings.length ? { ...out, warnings } : out;
}

function toward(v: V, c: V, t: number): V { return add(v, mul([c[0] - v[0], c[1] - v[1], c[2] - v[2]], t)); }
function clamp(t: number): number { return Math.max(0, Math.min(0.49, t)); }
function edgeSelectionOf(mesh: EditableMesh, faces: readonly number[]): ElementSelection { const s = new Set(faces), out: number[] = [], k = unwrapKernel(mesh.gpu.halfEdgeKernel); for (let e = 0; e < k.edgeCount; e++) if (s.has(k.edgeFaceA[e]) || s.has(k.edgeFaceB[e])) out.push(e); return selection("edge", out); }
