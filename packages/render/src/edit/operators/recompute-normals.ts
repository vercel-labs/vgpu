import { EditableMesh } from "../editable-mesh.ts";
import { normal, p, norm, add, sub, cross, type V } from "../operator-utils.ts";
import type { EditableMesh as EditableMeshValue } from "../types.ts";

export interface RecomputeNormalsOptions { readonly weighting?: "angle" | "area" | "uniform"; readonly creaseAngle?: number }
export interface RecomputeNormalsResult { readonly mesh: EditableMeshValue }

const DEFAULT_CREASE = Math.PI / 6;

export function recomputeNormals(em: EditableMeshValue, opts: RecomputeNormalsOptions = {}): RecomputeNormalsResult {
  if (em.faceCount === 0) return { mesh: em };
  const k = em.gpu.halfEdgeKernel;
  const mesh = EditableMesh.fromArrays({ positions: new Float32Array(k.positions), indices: new Uint32Array(k.faceVertices), useSmooth: new Uint8Array(k.useSmooth), creaseAngle: opts.creaseAngle ?? DEFAULT_CREASE });
  const nk = mesh.gpu.halfEdgeKernel, flats = flatNormals(mesh), out = new Float32Array(nk.faceNormals.length), visited = new Uint8Array(mesh.faceCount);
  for (let f = 0; f < mesh.faceCount; f++) {
    if (visited[f]) continue;
    const comp = nk.useSmooth[f] ? smoothComponent(mesh, f, visited) : (visited[f] = 1, [f]);
    if (comp.length === 1) out.set(flats.slice(f * 3, f * 3 + 3), f * 3);
    else {
      const n = componentNormal(mesh, comp, flats, opts.weighting ?? "angle");
      for (const face of comp) out.set(n, face * 3);
    }
  }
  nk.faceNormals.set(out);
  return { mesh };
}

function smoothComponent(em: EditableMeshValue, seed: number, visited: Uint8Array): number[] {
  const k = em.gpu.halfEdgeKernel, out: number[] = [], stack = [seed]; visited[seed] = 1;
  while (stack.length) {
    const f = stack.pop()!; out.push(f);
    for (const e of k.faceEdges.slice(f * 3, f * 3 + 3)) {
      if (k.isSharp[e]) continue;
      const n = k.edgeFaceA[e] === f ? k.edgeFaceB[e] : k.edgeFaceA[e];
      if (n >= 0 && k.useSmooth[n] && !visited[n]) { visited[n] = 1; stack.push(n); }
    }
  }
  return out;
}

function flatNormals(em: EditableMeshValue): Float32Array {
  const out = new Float32Array(em.faceCount * 3), k = em.gpu.halfEdgeKernel;
  for (let f = 0; f < em.faceCount; f++) out.set(normal(Array.from(k.faceVertices.slice(f * 3, f * 3 + 3), (v) => p(em, v))), f * 3);
  return out;
}

function componentNormal(em: EditableMeshValue, faces: readonly number[], flats: Float32Array, weighting: "angle" | "area" | "uniform"): V {
  let sum: V = [0, 0, 0];
  for (const f of faces) {
    const n: V = [flats[f * 3], flats[f * 3 + 1], flats[f * 3 + 2]], w = weighting === "uniform" ? 1 : weighting === "area" ? faceArea(em, f) : faceAngleSum(em, f);
    sum = add(sum, n, Math.max(w, 1e-12));
  }
  return norm(sum);
}

function faceArea(em: EditableMeshValue, f: number): number {
  const vs = Array.from(em.gpu.halfEdgeKernel.faceVertices.slice(f * 3, f * 3 + 3), (v) => p(em, v)), n = cross(sub(vs[1], vs[0]), sub(vs[2], vs[0]));
  return Math.hypot(n[0], n[1], n[2]) * 0.5;
}

function faceAngleSum(em: EditableMeshValue, f: number): number {
  const vs = Array.from(em.gpu.halfEdgeKernel.faceVertices.slice(f * 3, f * 3 + 3), (v) => p(em, v));
  return Math.max(cornerAngle(vs[1], vs[0], vs[2]), cornerAngle(vs[0], vs[1], vs[2]), cornerAngle(vs[0], vs[2], vs[1]));
}
function cornerAngle(a: V, o: V, b: V): number { const u = norm(sub(a, o)), v = norm(sub(b, o)); return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))); }
