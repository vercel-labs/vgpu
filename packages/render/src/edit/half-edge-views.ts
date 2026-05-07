import { v3, type HalfEdgeKernel } from "./half-edge-kernel.ts";
import type { EdgeView, FaceView, VertexView } from "./types.ts";

export function vertexView(k: HalfEdgeKernel, index: number): VertexView {
  const incident = edgesOfVertex(k, index), ns = [0, 0, 0];
  for (const f of facesOfVertex(k, index)) { ns[0] += k.faceNormals[f * 3]; ns[1] += k.faceNormals[f * 3 + 1]; ns[2] += k.faceNormals[f * 3 + 2]; }
  const l = Math.hypot(ns[0], ns[1], ns[2]) || 1;
  return { index, position: v3(k, index), normal: new Float32Array([ns[0] / l, ns[1] / l, ns[2] / l]) as never, valence: incident.length, isBoundary: incident.some((e) => k.edgeFaceB[e] < 0), isManifold: incident.every((e) => k.edgeFaceB[e] >= 0) };
}

export function edgeView(k: HalfEdgeKernel, index: number): EdgeView {
  const a = k.edgeVertexA[index], b = k.edgeVertexB[index], av = v3(k, a), bv = v3(k, b);
  const d = [bv[0] - av[0], bv[1] - av[1], bv[2] - av[2]], len = Math.hypot(d[0], d[1], d[2]) || 1;
  return { index, midpoint: new Float32Array([(av[0] + bv[0]) / 2, (av[1] + bv[1]) / 2, (av[2] + bv[2]) / 2]) as never, length: len, direction: new Float32Array([d[0] / len, d[1] / len, d[2] / len]) as never, vertexA: a, vertexB: b, faceA: k.edgeFaceA[index] < 0 ? null : k.edgeFaceA[index], faceB: k.edgeFaceB[index] < 0 ? null : k.edgeFaceB[index], isBoundary: k.edgeFaceB[index] < 0, isManifold: k.edgeFaceB[index] >= 0, isSharp: k.isSharp[index] === 1 };
}

export function faceView(k: HalfEdgeKernel, index: number): FaceView {
  const vs = Array.from(k.faceVertices.slice(index * 3, index * 3 + 3)), es = Array.from(k.faceEdges.slice(index * 3, index * 3 + 3));
  const ps = vs.map((v) => v3(k, v));
  const center = new Float32Array([(ps[0][0] + ps[1][0] + ps[2][0]) / 3, (ps[0][1] + ps[1][1] + ps[2][1]) / 3, (ps[0][2] + ps[1][2] + ps[2][2]) / 3]) as never;
  const area = Math.hypot(...cross(sub(ps[1], ps[0]), sub(ps[2], ps[0]))) / 2;
  return { index, center, normal: new Float32Array(k.faceNormals.slice(index * 3, index * 3 + 3)) as never, area, vertexCount: 3, vertexIndices: Object.freeze(vs), edgeIndices: Object.freeze(es), useSmooth: k.useSmooth[index] === 1 };
}

export function edgesOfVertex(k: HalfEdgeKernel, v: number): number[] {
  const out: number[] = [];
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === v || k.edgeVertexB[e] === v) out.push(e);
  return out;
}

export function facesOfVertex(k: HalfEdgeKernel, v: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < k.faceCount; f++) if (k.faceVertices.slice(f * 3, f * 3 + 3).includes(v)) out.push(f);
  return out;
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
