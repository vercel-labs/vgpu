import { MeshEditWarning } from "../warnings.ts";
import { EditableMesh } from "../editable-mesh.ts";
import { p, sub, cross, type V } from "../operator-utils.ts";
import type { EditableMesh as EditableMeshValue } from "../types.ts";

export interface HealManifoldReport { readonly nonManifoldEdgesFixed: number; readonly nonManifoldVerticesFixed: number; readonly holesFixed: number; readonly duplicateFacesRemoved: number }
export interface HealManifoldResult { readonly mesh: EditableMeshValue; readonly descendants: { readonly report: HealManifoldReport }; readonly warnings?: readonly MeshEditWarning[] }

export function healManifold(em: EditableMeshValue): HealManifoldResult {
  const k = em.gpu.halfEdgeKernel, positions = Array.from(k.positions), indices: number[] = [], smooth: number[] = [], edgeUse = new Map<string, number>(), seenFaces = new Set<string>();
  let nonManifoldEdgesFixed = 0, duplicateFacesRemoved = 0, degenerate = 0;
  for (let f = 0; f < em.faceCount; f++) {
    const tri = Array.from(k.faceVertices.slice(f * 3, f * 3 + 3));
    const faceKey = [...tri].sort((a, b) => a - b).join(":"), edges = triEdges(tri);
    if (new Set(tri).size < 3 || triArea(em, tri) <= 1e-12) { degenerate++; continue; }
    if (seenFaces.has(faceKey)) { duplicateFacesRemoved++; continue; }
    if (edges.some((e) => (edgeUse.get(e) ?? 0) >= 2)) { nonManifoldEdgesFixed++; continue; }
    seenFaces.add(faceKey); for (const e of edges) edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1);
    indices.push(...tri); smooth.push(k.useSmooth[f]);
  }
  const mesh = EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices), useSmooth: Uint8Array.from(smooth) });
  preserveSharp(em, mesh);
  const warnings: MeshEditWarning[] = [];
  if (degenerate) warnings.push(new MeshEditWarning("DEGENERATE_FACE_DROPPED", `${degenerate} zero-area face(s) were removed while healing manifold topology.`));
  if (!mesh.isManifold || hasOverusedEdges(mesh)) warnings.push(new MeshEditWarning("HEAL_NON_MANIFOLD_RESIDUE", "Some non-manifold residue remains after deterministic healManifold cleanup."));
  const report = { nonManifoldEdgesFixed, nonManifoldVerticesFixed: 0, holesFixed: 0, duplicateFacesRemoved };
  const out = { mesh, descendants: { report } };
  return warnings.length ? { ...out, warnings } : out;
}

function preserveSharp(oldMesh: EditableMeshValue, mesh: EditableMeshValue): void {
  const oldSharp = new Set<string>(), ok = oldMesh.gpu.halfEdgeKernel, nk = mesh.gpu.halfEdgeKernel;
  for (let e = 0; e < oldMesh.edgeCount; e++) if (ok.isSharp[e]) oldSharp.add(posKey(p(oldMesh, ok.edgeVertexA[e]), p(oldMesh, ok.edgeVertexB[e])));
  nk.isSharp.fill(0);
  for (let e = 0; e < mesh.edgeCount; e++) if (oldSharp.has(posKey(p(mesh, nk.edgeVertexA[e]), p(mesh, nk.edgeVertexB[e])))) nk.isSharp[e] = 1;
}

function hasOverusedEdges(em: EditableMeshValue): boolean {
  const counts = new Map<string, number>(), k = em.gpu.halfEdgeKernel;
  for (let f = 0; f < em.faceCount; f++) for (const e of triEdges(Array.from(k.faceVertices.slice(f * 3, f * 3 + 3)))) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts.values()].some((v) => v !== 2);
}

function triEdges(t: readonly number[]): string[] { return [edgeKey(t[0], t[1]), edgeKey(t[1], t[2]), edgeKey(t[2], t[0])]; }
function edgeKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function posKey(a: V, b: V): string { const ka = q(a), kb = q(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; }
function q(v: V): string { return `${Math.fround(v[0])},${Math.fround(v[1])},${Math.fround(v[2])}`; }
function triArea(em: EditableMeshValue, tri: readonly number[]): number { const n = cross(sub(p(em, tri[1]), p(em, tri[0])), sub(p(em, tri[2]), p(em, tri[0]))); return Math.hypot(n[0], n[1], n[2]) * 0.5; }
