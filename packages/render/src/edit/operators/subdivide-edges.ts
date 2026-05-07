import { selection } from "../selection.ts";
import { addTri, build, edgeVerts, faceVerts, key, p, requireSelection, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface SubdivideEdgesOptions { readonly cuts?: number }
export interface SubdivideEdgesResult { readonly mesh: EditableMesh; readonly descendants: { readonly newVertices: ElementSelection; readonly newEdges: ElementSelection } }

export function subdivideEdges(em: EditableMesh, edges: ElementSelection, opts: SubdivideEdgesOptions = {}): SubdivideEdgesResult {
  requireSelection(edges, "edge");
  const cuts = Math.max(1, Math.floor(opts.cuts ?? 1)), selected = new Set(edges.indices), k = em.gpu.halfEdgeKernel;
  const parts: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() }, newVertexKeys = new Set<string>(), childKeys = new Set<string>();
  const points = new Map<number, V[]>();
  for (const e of selected) {
    const [a, b] = edgeVerts(em, e), av = p(em, a), bv = p(em, b), ps: V[] = [av];
    for (let i = 1; i <= cuts; i++) { const v = lerp(av, bv, i / (cuts + 1)); ps.push(v); newVertexKeys.add(key(v, v)); }
    ps.push(bv); points.set(e, ps);
    for (let i = 0; i < ps.length - 1; i++) { childKeys.add(key(ps[i], ps[i + 1])); if (k.isSharp[e]) parts.sharp.add(key(ps[i], ps[i + 1])); }
  }
  for (let f = 0; f < em.faceCount; f++) emitFace(em, f, selected, points, parts);
  copyUnselectedSharp(em, selected, parts);
  const mesh = build(parts), newVertices = verticesByKeys(mesh, newVertexKeys), newEdges = edgesByKeys(mesh, childKeys);
  tintFaces(mesh, facesOfEdges(mesh, newEdges.indices));
  return { mesh, descendants: { newVertices, newEdges } };
}

function emitFace(em: EditableMesh, f: number, selected: Set<number>, points: Map<number, V[]>, parts: MeshParts): void {
  const k = em.gpu.halfEdgeKernel, verts = faceVerts(em, f).map((i) => p(em, i)), edges = Array.from(k.faceEdges.slice(f * 3, f * 3 + 3)), picked = edges.map((e) => selected.has(e));
  const n = picked.filter(Boolean).length, smooth = k.useSmooth[f];
  if (n === 0) { addTri(parts, verts[0], verts[1], verts[2], smooth); return; }
  if (n === 1) { const i = picked.findIndex(Boolean), ps = oriented(points.get(edges[i])!, verts[i], verts[(i + 1) % 3]), o = verts[(i + 2) % 3]; for (let j = 0; j < ps.length - 1; j++) addTri(parts, o, ps[j], ps[j + 1], smooth); return; }
  if (n === 2 && (points.get(edges[picked.findIndex(Boolean)])?.length ?? 0) === 3) { emitTwoCut(verts, edges, picked, points, parts, smooth); return; }
  if (n === 3 && (points.get(edges[0])?.length ?? 0) === 3) { const m = edges.map((e, i) => oriented(points.get(e)!, verts[i], verts[(i + 1) % 3])[1]); addTri(parts, verts[0], m[0], m[2], smooth); addTri(parts, m[0], verts[1], m[1], smooth); addTri(parts, m[2], m[1], verts[2], smooth); addTri(parts, m[0], m[1], m[2], smooth); return; }
  addTri(parts, verts[0], verts[1], verts[2], smooth);
}

function emitTwoCut(verts: V[], edges: number[], picked: boolean[], points: Map<number, V[]>, parts: MeshParts, smooth: number): void {
  const u = picked.findIndex((v, i) => !v && picked[(i + 1) % 3] && picked[(i + 2) % 3]), a = verts[u], s = verts[(u + 2) % 3], b = verts[(u + 1) % 3];
  const ms = oriented(points.get(edges[(u + 1) % 3])!, b, s)[1], ma = oriented(points.get(edges[(u + 2) % 3])!, s, a)[1];
  addTri(parts, ma, s, ms, smooth); addTri(parts, a, ma, b, smooth); addTri(parts, ma, ms, b, smooth);
}

function oriented(ps: V[], a: V, b: V): V[] { return key(ps[0], a) === key(a, a) && key(ps[ps.length - 1], b) === key(b, b) ? ps : [...ps].reverse(); }
function lerp(a: V, b: V, t: number): V { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function copyUnselectedSharp(em: EditableMesh, selected: Set<number>, parts: MeshParts): void { const k = em.gpu.halfEdgeKernel; for (let e = 0; e < k.edgeCount; e++) if (!selected.has(e) && k.isSharp[e]) parts.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e]))); }
function verticesByKeys(em: EditableMesh, keys: Set<string>): ElementSelection { const out: number[] = [], a = em.gpu.halfEdgeKernel.positions; for (let v = 0; v < em.vertexCount; v++) if (keys.has(key(pos(a, v), pos(a, v)))) out.push(v); return selection("vertex", out); }
function edgesByKeys(em: EditableMesh, keys: Set<string>): ElementSelection { const out: number[] = [], k = em.gpu.halfEdgeKernel; for (let e = 0; e < em.edgeCount; e++) if (keys.has(key(pos(k.positions, k.edgeVertexA[e]), pos(k.positions, k.edgeVertexB[e])))) out.push(e); return selection("edge", out); }
function facesOfEdges(em: EditableMesh, edges: readonly number[]): number[] { const k = em.gpu.halfEdgeKernel, out = new Set<number>(); for (const e of edges) { if (k.edgeFaceA[e] >= 0) out.add(k.edgeFaceA[e]); if (k.edgeFaceB[e] >= 0) out.add(k.edgeFaceB[e]); } return [...out]; }
function tintFaces(em: EditableMesh, faces: readonly number[]): void { const n = em.gpu.halfEdgeKernel.faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
function pos(a: Float32Array, v: number): V { const i = v * 3; return [a[i], a[i + 1], a[i + 2]]; }
