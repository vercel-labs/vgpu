import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { add, addQuad, addTri, build, center, faceVerts, key, normal, p, requireSelection, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface ExtrudeOptions { readonly distance: number; readonly inset?: number; readonly direction?: V; readonly mode?: "region" | "individual" }
export interface ExtrudeResult { readonly mesh: EditableMesh; readonly descendants: { readonly sideFaces: ElementSelection; readonly capFaces: ElementSelection; readonly sideEdges: ElementSelection; readonly capRing: ElementSelection }; readonly warnings?: readonly MeshEditWarning[] }

export function extrude(em: EditableMesh, faces: ElementSelection, opts: ExtrudeOptions): ExtrudeResult {
  requireSelection(faces, "face");
  const selected = new Set(faces.indices), parts: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() };
  const side: number[] = [], cap: number[] = [], source = em.gpu.halfEdgeKernel;
  for (let f = 0; f < em.faceCount; f++) if (!selected.has(f)) {
    const v = faceVerts(em, f).map((i) => p(em, i));
    addTri(parts, v[0], v[1], v[2], source.useSmooth[f]);
    for (const e of source.faceEdges.slice(f * 3, f * 3 + 3)) if (source.isSharp[e]) parts.sharp.add(key(p(em, source.edgeVertexA[e]), p(em, source.edgeVertexB[e])));
  }
  for (const f of faces.indices) {
    const verts = faceVerts(em, f).map((i) => p(em, i)), n = opts.direction ? normOpt(opts.direction) : normal(verts), c = center(verts);
    const lifted = verts.map((v) => add(inset(v, c, opts.inset ?? 0), n, opts.distance));
    cap.push(addTri(parts, lifted[0], lifted[1], lifted[2], source.useSmooth[f]));
    for (let i = 0; i < 3; i++) {
      const q = addQuad(parts, verts[i], verts[(i + 1) % 3], lifted[(i + 1) % 3], lifted[i], 1);
      side.push(...q); parts.sharp.add(key(verts[i], lifted[i])); parts.sharp.add(key(lifted[i], lifted[(i + 1) % 3]));
    }
  }
  const mesh = build(parts), sideFaces = selection("face", side), capFaces = selection("face", cap);
  return { mesh, descendants: { sideFaces, capFaces, sideEdges: edgeSelection(mesh, sideFaces), capRing: edgeSelection(mesh, capFaces) } };
}

function inset(v: V, c: V, d: number): V { return d === 0 ? v : [v[0] + (c[0] - v[0]) * d, v[1] + (c[1] - v[1]) * d, v[2] + (c[2] - v[2]) * d]; }
function normOpt(v: V): V { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function edgeSelection(mesh: EditableMesh, sel: ElementSelection): ElementSelection { return mesh.edges.boundaryOf(sel).count ? mesh.edges.boundaryOf(sel) : mesh.edges.byIndex([]); }
