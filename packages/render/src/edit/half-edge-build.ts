import { makeKernel, type HalfEdgeKernel } from "./half-edge-kernel.ts";
import type { FromArraysOptions } from "./types.ts";

const DEFAULT_CREASE = Math.PI / 6;

export function buildKernel(opts: FromArraysOptions): HalfEdgeKernel {
  const idx = opts.indices ?? Uint32Array.from({ length: opts.positions.length / 3 }, (_, i) => i);
  const map = new Map<string, number>(), pos: number[] = [], fv = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const s = idx[i] * 3, key = `${opts.positions[s]},${opts.positions[s + 1]},${opts.positions[s + 2]}`;
    let v = map.get(key);
    if (v === undefined) { v = pos.length / 3; map.set(key, v); pos.push(opts.positions[s], opts.positions[s + 1], opts.positions[s + 2]); }
    fv[i] = v;
  }
  const faceCount = fv.length / 3, edgeMap = new Map<string, number>(), fe = new Uint32Array(fv.length);
  const ea: number[] = [], eb: number[] = [], fa: number[] = [], fb: number[] = [];
  for (let f = 0; f < faceCount; f++) for (let c = 0; c < 3; c++) {
    const a = fv[f * 3 + c], b = fv[f * 3 + ((c + 1) % 3)], lo = Math.min(a, b), hi = Math.max(a, b), key = `${lo}:${hi}`;
    let e = edgeMap.get(key);
    if (e === undefined) { e = ea.length; edgeMap.set(key, e); ea.push(lo); eb.push(hi); fa.push(f); fb.push(-1); }
    else if (fb[e] < 0) fb[e] = f;
    fe[f * 3 + c] = e;
  }
  const faceNormals = normals(new Float32Array(pos), fv);
  const sharp = opts.sharpEdges ? new Uint8Array(opts.sharpEdges) : autoSharp(fa, fb, faceNormals, opts.creaseAngle ?? DEFAULT_CREASE);
  const smooth = opts.useSmooth ? new Uint8Array(opts.useSmooth) : new Uint8Array(faceCount).fill(1);
  return makeKernel({ positions: new Float32Array(pos), faceVertices: fv, faceEdges: fe, edgeVertexA: Uint32Array.from(ea), edgeVertexB: Uint32Array.from(eb), edgeFaceA: Int32Array.from(fa), edgeFaceB: Int32Array.from(fb), isSharp: sharp, useSmooth: smooth, faceNormals, vertexCount: pos.length / 3, edgeCount: ea.length, faceCount });
}

function normals(pos: Float32Array, fv: Uint32Array): Float32Array {
  const out = new Float32Array(fv.length);
  for (let f = 0; f < fv.length / 3; f++) {
    const a = fv[f * 3] * 3, b = fv[f * 3 + 1] * 3, c = fv[f * 3 + 2] * 3;
    const ab = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], ac = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
    out.set([n[0] / l, n[1] / l, n[2] / l], f * 3);
  }
  return out;
}

function autoSharp(fa: number[], fb: number[], n: Float32Array, crease: number): Uint8Array {
  const out = new Uint8Array(fa.length), cos = Math.cos(crease);
  for (let e = 0; e < fa.length; e++) {
    if (fb[e] < 0) out[e] = 1;
    else { const a = fa[e] * 3, b = fb[e] * 3; out[e] = n[a] * n[b] + n[a + 1] * n[b + 1] + n[a + 2] * n[b + 2] < cos ? 1 : 0; }
  }
  return out;
}
