import { MeshEditWarning } from "../warnings.ts";
import { EditableMesh } from "../editable-mesh.ts";
import { unwrapKernel } from "../kernel-handle.ts";
import { requireSelection, p, normal, type V } from "../operator-utils.ts";
import type { EditableMesh as EditableMeshValue, ElementSelection } from "../types.ts";

export interface MergeByDistanceOptions { readonly threshold?: number; readonly selection?: ElementSelection; readonly key?: "position" | "full-vertex" }
export interface MergeByDistanceResult { readonly mesh: EditableMeshValue; readonly mergeMap: ReadonlyMap<number, number>; readonly weldedCount: number; readonly warnings?: readonly MeshEditWarning[] }

export function mergeByDistance(em: EditableMeshValue, opts: MergeByDistanceOptions = {}): MergeByDistanceResult {
  const vertices = opts.selection ?? em.vertices.all(); requireSelection(vertices, "vertex");
  const threshold = opts.threshold ?? 1e-4, clusters = clusterVertices(em, vertices.indices, threshold), oldToSurvivor = new Map<number, number>();
  for (let v = 0; v < em.vertexCount; v++) oldToSurvivor.set(v, v);
  for (const c of clusters) for (const v of c) oldToSurvivor.set(v, c[0]);
  const used = usedSurvivors(em, oldToSurvivor), survivorToNew = new Map<number, number>(), positions: number[] = [];
  for (const s of used) { survivorToNew.set(s, positions.length / 3); positions.push(...p(em, s)); }
  const k = unwrapKernel(em.gpu.halfEdgeKernel), indices: number[] = [], smooth: number[] = [], warnings: MeshEditWarning[] = [];
  let degenerate = 0;
  for (let f = 0; f < em.faceCount; f++) {
    const tri = Array.from(k.faceVertices.slice(f * 3, f * 3 + 3), (v) => survivorToNew.get(oldToSurvivor.get(v)!)!);
    if (new Set(tri).size < 3 || area(positions, tri) <= 1e-12) { degenerate++; continue; }
    indices.push(...tri); smooth.push(k.useSmooth[f]);
  }
  if (degenerate) warnings.push(new MeshEditWarning("MERGE_DEGENERATE_FACES_REMOVED", `${degenerate} face(s) collapsed during mergeByDistance and were removed.`));
  if (opts.key === "position" && (em.hasUVs || em.hasNormals || em.hasVertexColors)) warnings.push(new MeshEditWarning("SEAM_DESTROYED", "Position-only merge may destroy attribute seams."));
  const mesh = EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices), useSmooth: Uint8Array.from(smooth) });
  applySharpOr(em, mesh, oldToSurvivor, survivorToNew);
  const mergeMap = new Map<number, number>();
  for (let v = 0; v < em.vertexCount; v++) mergeMap.set(v, survivorToNew.get(oldToSurvivor.get(v)!) ?? -1);
  const out = { mesh, mergeMap, weldedCount: em.vertexCount - used.length };
  return warnings.length ? { ...out, warnings } : out;
}

function clusterVertices(em: EditableMeshValue, selected: readonly number[], threshold: number): number[][] {
  const pending = [...selected].sort((a, b) => a - b), out: number[][] = [];
  while (pending.length) {
    const seed = pending.shift()!, cluster = [seed];
    for (let i = pending.length - 1; i >= 0; i--) if (dist(p(em, seed), p(em, pending[i])) <= threshold) cluster.push(pending.splice(i, 1)[0]);
    cluster.sort((a, b) => a - b); if (cluster.length > 1) out.push(cluster);
  }
  return out;
}

function usedSurvivors(em: EditableMeshValue, map: ReadonlyMap<number, number>): number[] {
  const used = new Set<number>(), k = unwrapKernel(em.gpu.halfEdgeKernel);
  for (let i = 0; i < k.faceVertices.length; i++) used.add(map.get(k.faceVertices[i])!);
  return [...used].sort((a, b) => a - b);
}

function applySharpOr(em: EditableMeshValue, mesh: EditableMeshValue, oldToSurvivor: ReadonlyMap<number, number>, survivorToNew: ReadonlyMap<number, number>): void {
  const sharp = new Set<string>(), k = unwrapKernel(em.gpu.halfEdgeKernel);
  for (let e = 0; e < em.edgeCount; e++) if (k.isSharp[e]) {
    const a = survivorToNew.get(oldToSurvivor.get(k.edgeVertexA[e])!)!, b = survivorToNew.get(oldToSurvivor.get(k.edgeVertexB[e])!)!;
    if (a !== b) sharp.add(edgeKey(a, b));
  }
  const nk = unwrapKernel(mesh.gpu.halfEdgeKernel); nk.isSharp.fill(0);
  for (let e = 0; e < mesh.edgeCount; e++) if (sharp.has(edgeKey(nk.edgeVertexA[e], nk.edgeVertexB[e]))) nk.isSharp[e] = 1;
}

function dist(a: V, b: V): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function edgeKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function area(pos: number[], tri: readonly number[]): number { return Math.hypot(...normal(tri.map((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]] as V))); }
