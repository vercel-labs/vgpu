import { EditableMesh } from "./editable-mesh.ts";
import { MeshEditError } from "./errors.ts";
import { selection } from "./selection.ts";
import type { EditableMesh as EditableMeshValue, ElementSelection } from "./types.ts";

export type V = readonly [number, number, number];
export interface MeshParts { readonly positions: number[]; readonly faces: number[][]; readonly useSmooth: number[]; readonly sharp: Set<string> }

export function requireSelection(sel: ElementSelection, domain: "vertex" | "face" | "edge"): void {
  if (sel.domain !== domain) throw new MeshEditError({ code: "WRONG_DOMAIN" });
  if (sel.count === 0) throw new MeshEditError({ code: "EMPTY_SELECTION" });
}

export function faceVerts(em: EditableMeshValue, f: number): number[] { return Array.from(em.gpu.halfEdgeKernel.faceVertices.slice(f * 3, f * 3 + 3)); }
export function edgeVerts(em: EditableMeshValue, e: number): [number, number] { const k = em.gpu.halfEdgeKernel; return [k.edgeVertexA[e], k.edgeVertexB[e]]; }
export function p(em: EditableMeshValue, v: number): V { const a = em.gpu.halfEdgeKernel.positions, i = v * 3; return [a[i], a[i + 1], a[i + 2]]; }
export function add(a: V, b: V, s = 1): V { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
export function sub(a: V, b: V): V { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function mul(a: V, s: number): V { return [a[0] * s, a[1] * s, a[2] * s]; }
export function norm(a: V): V { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export function cross(a: V, b: V): V { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function center(ps: V[]): V { return mul(ps.reduce((a, b) => add(a, b), [0, 0, 0] as V), 1 / ps.length); }
export function normal(ps: V[]): V { return norm(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0]))); }
export function key(a: V, b: V): string { const ka = q(a), kb = q(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; }

export function addTri(m: MeshParts, a: V, b: V, c: V, smooth = 1): number {
  const i = m.positions.length / 3;
  m.positions.push(...a, ...b, ...c); m.faces.push([i, i + 1, i + 2]); m.useSmooth.push(smooth); return m.faces.length - 1;
}

export function addQuad(m: MeshParts, a: V, b: V, c: V, d: V, smooth = 1): [number, number] {
  return [addTri(m, a, b, c, smooth), addTri(m, a, c, d, smooth)];
}

export function build(m: MeshParts): EditableMeshValue {
  const mesh = EditableMesh.fromArrays({ positions: new Float32Array(m.positions), indices: new Uint32Array(m.faces.flat()), useSmooth: Uint8Array.from(m.useSmooth) });
  const k = mesh.gpu.halfEdgeKernel;
  k.isSharp.fill(0);
  for (let e = 0; e < k.edgeCount; e++) if (m.sharp.has(key(pos(k.positions, k.edgeVertexA[e]), pos(k.positions, k.edgeVertexB[e])))) k.isSharp[e] = 1;
  return mesh;
}

export function edgeSelectionOfFaces(em: EditableMeshValue, faces: readonly number[]) {
  const s = new Set(faces), out: number[] = [], k = em.gpu.halfEdgeKernel;
  for (let e = 0; e < k.edgeCount; e++) if (s.has(k.edgeFaceA[e]) || s.has(k.edgeFaceB[e])) out.push(e);
  return selection("edge", out);
}

export function copyWithoutFaces(em: EditableMeshValue, drop: ReadonlySet<number>): MeshParts {
  const k = em.gpu.halfEdgeKernel, m: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() };
  for (let f = 0; f < em.faceCount; f++) if (!drop.has(f)) addTri(m, p(em, k.faceVertices[f * 3]), p(em, k.faceVertices[f * 3 + 1]), p(em, k.faceVertices[f * 3 + 2]), k.useSmooth[f]);
  for (let e = 0; e < em.edgeCount; e++) if (k.isSharp[e]) m.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e])));
  return m;
}

export function addFan(m: MeshParts, verts: readonly V[], smooth: number): number[] {
  const out: number[] = [], start = m.faces.length;
  for (let i = 1; i < verts.length - 1; i++) { addTri(m, verts[0], verts[i], verts[i + 1], smooth); out.push(start + i - 1); }
  return out;
}

export function range(a: number, b: number): number[] { return Array.from({ length: b - a }, (_, i) => a + i); }
export function tint(em: EditableMeshValue, faces: readonly number[]): void { const n = em.gpu.halfEdgeKernel.faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
export function pos(a: Float32Array, v: number): V { const i = v * 3; return [a[i], a[i + 1], a[i + 2]]; }
function q(v: V): string { return `${Math.fround(v[0])},${Math.fround(v[1])},${Math.fround(v[2])}`; }
