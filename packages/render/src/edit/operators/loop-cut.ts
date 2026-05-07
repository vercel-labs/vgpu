import { MeshEditError } from "../errors.ts";
import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addQuad, addTri, build, edgeVerts, key, normal, p, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";
import { subdivideEdges } from "./subdivide-edges.ts";

import { unwrapKernel } from "../kernel-handle.ts";
export interface LoopCutOptions { readonly cuts?: number; readonly slide?: number; readonly markSharp?: boolean }
export interface LoopCutResult { readonly mesh: EditableMesh; readonly insertedLoop: ElementSelection; readonly warnings?: readonly MeshEditWarning[] }
interface Link { readonly a: number; readonly b: number; readonly faces: readonly [number, number] }

export function loopCut(em: EditableMesh, seedEdge: number, opts: LoopCutOptions = {}): LoopCutResult {
  if (seedEdge < 0 || seedEdge >= em.edgeCount) throw new MeshEditError({ code: "EMPTY_SELECTION" });
  const ring = collectRing(em, seedEdge);
  if (!ring) return fallback(em, seedEdge, opts);
  const cut = cutRing(em, ring, clamp01(0.5 + (opts.slide ?? 0) * 0.5), opts.markSharp ?? false);
  return { mesh: cut.mesh, insertedLoop: selection("edge", cut.edges, true) };
}

function fallback(em: EditableMesh, seedEdge: number, opts: LoopCutOptions): LoopCutResult {
  const result = subdivideEdges(em, selection("edge", [seedEdge], true), { cuts: opts.cuts ?? 1 });
  for (const e of result.newEdges.indices) unwrapKernel(result.mesh.gpu.halfEdgeKernel).isSharp[e] = 0;
  return { mesh: result.mesh, insertedLoop: selection("edge", result.newEdges.indices, true), warnings: [new MeshEditWarning("LOOP_CUT_AMBIGUOUS_CONTINUATION", "Loop cut could not find an unambiguous continuation; only the seed edge was cut.", { domain: "edge", index: seedEdge })] };
}

function collectRing(em: EditableMesh, seed: number): { readonly edges: readonly number[]; readonly links: readonly Link[] } | null {
  // v1 kernel has face slots but no twin half-edges, so we infer loop steps through coplanar triangle pairs.
  const graph = new Map<number, Map<number, Link>>();
  for (let e = 0; e < em.edgeCount; e++) for (const f of edgeFaces(em, e)) {
    const link = continuation(em, e, f);
    if (link) { addLink(graph, link.a, link.b, link); addLink(graph, link.b, link.a, link); }
  }
  const first = graph.get(seed);
  if (!first || first.size !== 2) return null;
  const edges = [seed], links: Link[] = [];
  let prev = -1, cur = seed;
  for (let guard = 0; guard <= em.edgeCount; guard++) {
    const nexts = graph.get(cur);
    if (!nexts || nexts.size !== 2) return null;
    const next = [...nexts.keys()].find((e) => e !== prev);
    if (next === undefined) return null;
    links.push(nexts.get(next)!);
    if (next === seed) return edges.length > 2 ? { edges, links } : null;
    if (edges.includes(next)) return null;
    edges.push(next); prev = cur; cur = next;
  }
  return null;
}

function cutRing(em: EditableMesh, ring: { readonly edges: readonly number[]; readonly links: readonly Link[] }, t: number, markSharp: boolean): { readonly mesh: EditableMesh; readonly edges: readonly number[] } {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), drop = new Set(ring.links.flatMap((l) => l.faces)), rails = new Set(ring.edges);
  const parts: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() }, cutPoints = new Map<number, V>(), ringKeys = new Set<string>();
  for (let f = 0; f < em.faceCount; f++) if (!drop.has(f)) addTri(parts, p(em, k.faceVertices[f * 3]), p(em, k.faceVertices[f * 3 + 1]), p(em, k.faceVertices[f * 3 + 2]), k.useSmooth[f]);
  for (const e of ring.edges) cutPoints.set(e, splitPoint(em, e, t));
  for (const link of ring.links) {
    const dir = edgeDir(em, link.a), [a0, a1] = orderedEdgeDir(em, link.a, dir), [b0, b1] = orderedEdgeDir(em, link.b, dir), ma = cutPoints.get(link.a)!, mb = cutPoints.get(link.b)!;
    const smooth = Math.max(k.useSmooth[link.faces[0]], k.useSmooth[link.faces[1]]), target = faceNormal(em, link.faces[0]);
    addQuadOriented(parts, a0, b0, mb, ma, smooth, target); addQuadOriented(parts, ma, mb, b1, a1, smooth, target);
    ringKeys.add(key(ma, mb)); if (markSharp) parts.sharp.add(key(ma, mb));
  }
  for (let e = 0; e < em.edgeCount; e++) if (k.isSharp[e] && !isDroppedDiagonal(em, e, drop) && !rails.has(e)) parts.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e])));
  for (const e of ring.edges) if (k.isSharp[e]) { const [a, b] = orderedEdge(em, e), m = cutPoints.get(e)!; parts.sharp.add(key(a, m)); parts.sharp.add(key(m, b)); }
  const mesh = build(parts), out: number[] = [], nk = unwrapKernel(mesh.gpu.halfEdgeKernel);
  for (let e = 0; e < mesh.edgeCount; e++) if (ringKeys.has(key(pos(nk.positions, nk.edgeVertexA[e]), pos(nk.positions, nk.edgeVertexB[e])))) out.push(e);
  tintFaces(mesh, out);
  return { mesh, edges: out };
}

function continuation(em: EditableMesh, e: number, face: number): Link | null {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), fe = Array.from(k.faceEdges.slice(face * 3, face * 3 + 3)), out: Link[] = [];
  for (const bridge of fe) if (bridge !== e) {
    const other = k.opposite(bridge, face);
    if (other === null || dot(faceNormal(em, face), faceNormal(em, other)) < 0.999) continue;
    for (const r of Array.from(k.faceEdges.slice(other * 3, other * 3 + 3))) if (r !== bridge && r !== e && disjoint(em, e, r) && parallel(em, e, r)) out.push({ a: e, b: r, faces: [face, other] });
  }
  return out.length === 1 ? out[0] : null;
}

function addLink(graph: Map<number, Map<number, Link>>, a: number, b: number, link: Link): void { const m = graph.get(a) ?? new Map<number, Link>(); m.set(b, link); graph.set(a, m); }
function edgeFaces(em: EditableMesh, e: number): number[] { const k = unwrapKernel(em.gpu.halfEdgeKernel), out = [k.edgeFaceA[e], k.edgeFaceB[e]].filter((f) => f >= 0); return out.length === 2 ? out : []; }
function disjoint(em: EditableMesh, a: number, b: number): boolean { const av = new Set(edgeVerts(em, a)); return edgeVerts(em, b).every((v) => !av.has(v)); }
function parallel(em: EditableMesh, a: number, b: number): boolean { const da = edgeDir(em, a), db = edgeDir(em, b); return Math.abs(dot(da, db)) > 0.999; }
function edgeDir(em: EditableMesh, e: number): V { const [a, b] = edgeVerts(em, e), av = p(em, a), bv = p(em, b), d: V = [bv[0] - av[0], bv[1] - av[1], bv[2] - av[2]], l = Math.hypot(...d) || 1; return [d[0] / l, d[1] / l, d[2] / l]; }
function orderedEdge(em: EditableMesh, e: number): [V, V] { return orderedEdgeDir(em, e, edgeDir(em, e)); }
function orderedEdgeDir(em: EditableMesh, e: number, d: V): [V, V] { const [a, b] = edgeVerts(em, e), av = p(em, a), bv = p(em, b); return dot(av, d) <= dot(bv, d) ? [av, bv] : [bv, av]; }
function splitPoint(em: EditableMesh, e: number, t: number): V { const [a, b] = orderedEdge(em, e); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function faceNormal(em: EditableMesh, f: number): V { const n = unwrapKernel(em.gpu.halfEdgeKernel).faceNormals, i = f * 3; return [n[i], n[i + 1], n[i + 2]]; }
function addQuadOriented(m: MeshParts, a: V, b: V, c: V, d: V, smooth: number, target: V): void { dot(normal([a, b, c]), target) >= 0 ? addQuad(m, a, b, c, d, smooth) : addQuad(m, a, d, c, b, smooth); }
function isDroppedDiagonal(em: EditableMesh, e: number, drop: Set<number>): boolean { const k = unwrapKernel(em.gpu.halfEdgeKernel); return drop.has(k.edgeFaceA[e]) && drop.has(k.edgeFaceB[e]); }
function tintFaces(em: EditableMesh, edges: readonly number[]): void { const k = unwrapKernel(em.gpu.halfEdgeKernel); for (const e of edges) for (const f of [k.edgeFaceA[e], k.edgeFaceB[e]]) if (f >= 0) k.faceNormals.set([0.577, 0.577, 0.577], f * 3); }
function dot(a: readonly number[], b: readonly number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function clamp01(v: number): number { return Math.max(0.001, Math.min(0.999, v)); }
function pos(a: Float32Array, v: number): V { const i = v * 3; return [a[i], a[i + 1], a[i + 2]]; }
