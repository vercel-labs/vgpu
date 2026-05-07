import { selection } from "../selection.ts";
import { addTri, build, faceVerts, key, p, requireSelection, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface SubdivideFacesOptions { readonly cuts?: number }
export interface SubdivideFacesResult { readonly mesh: EditableMesh; readonly descendants: { readonly newFaces: ElementSelection; readonly newEdges: ElementSelection } }

export function subdivideFaces(em: EditableMesh, faces: ElementSelection, opts: SubdivideFacesOptions = {}): SubdivideFacesResult {
  requireSelection(faces, "face");
  let result = once(em, faces);
  for (let i = 1; i < Math.max(1, Math.floor(opts.cuts ?? 1)); i++) result = once(result.mesh, result.descendants.newFaces);
  return result;
}

function once(em: EditableMesh, faces: ElementSelection): SubdivideFacesResult {
  const selected = new Set(faces.indices), parts: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() }, k = em.gpu.halfEdgeKernel;
  const newFaces: number[] = [], newEdgeKeys = new Set<string>();
  for (let f = 0; f < em.faceCount; f++) {
    const v = faceVerts(em, f).map((i) => p(em, i)), smooth = k.useSmooth[f];
    if (!selected.has(f)) { addTri(parts, v[0], v[1], v[2], smooth); copySharp(em, parts, f); continue; }
    const m = [mid(v[0], v[1]), mid(v[1], v[2]), mid(v[2], v[0])];
    newFaces.push(addTri(parts, v[0], m[0], m[2], smooth), addTri(parts, m[0], v[1], m[1], smooth), addTri(parts, m[2], m[1], v[2], smooth), addTri(parts, m[0], m[1], m[2], smooth));
    for (const [a, b] of [[v[0], m[0]], [m[0], v[1]], [v[1], m[1]], [m[1], v[2]], [v[2], m[2]], [m[2], v[0]], [m[0], m[1]], [m[1], m[2]], [m[2], m[0]]] as [V, V][]) newEdgeKeys.add(key(a, b));
    for (let i = 0; i < 3; i++) if (k.isSharp[k.faceEdges[f * 3 + i]]) { parts.sharp.add(key(v[i], m[i])); parts.sharp.add(key(m[i], v[(i + 1) % 3])); }
  }
  const mesh = build(parts), descFaces = selection("face", newFaces);
  tintFaces(mesh, descFaces.indices);
  return { mesh, descendants: { newFaces: descFaces, newEdges: edgesByKeys(mesh, newEdgeKeys) } };
}

function copySharp(em: EditableMesh, parts: MeshParts, f: number): void { const k = em.gpu.halfEdgeKernel; for (const e of k.faceEdges.slice(f * 3, f * 3 + 3)) if (k.isSharp[e]) parts.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e]))); }
function mid(a: V, b: V): V { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }
function edgesByKeys(em: EditableMesh, keys: Set<string>): ElementSelection { const out: number[] = [], k = em.gpu.halfEdgeKernel; for (let e = 0; e < em.edgeCount; e++) if (keys.has(key(pos(k.positions, k.edgeVertexA[e]), pos(k.positions, k.edgeVertexB[e])))) out.push(e); return selection("edge", out); }
function tintFaces(em: EditableMesh, faces: readonly number[]): void { const n = em.gpu.halfEdgeKernel.faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
function pos(a: Float32Array, v: number): V { const i = v * 3; return [a[i], a[i + 1], a[i + 2]]; }
