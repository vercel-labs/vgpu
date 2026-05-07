import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addFan, build, copyWithoutFaces, p, requireSelection, tint } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface DissolveFacesResult { readonly mesh: EditableMesh; readonly descendants: { readonly resultFace: ElementSelection }; readonly warnings?: readonly MeshEditWarning[] }

export function dissolveFaces(em: EditableMesh, faces: ElementSelection): DissolveFacesResult {
  requireSelection(faces, "face");
  const selected = new Set(faces.indices), warnings: MeshEditWarning[] = [];
  const parts = copyWithoutFaces(em, selected), start = parts.faces.length, smooth = orSmooth(em, selected);
  let made = 0;
  for (const comp of components(em, selected)) {
    const loop = boundaryLoop(em, comp);
    if (loop.length < 3) { warnings.push(new MeshEditWarning("DEGENERATE_FACE_DROPPED", "Dissolved face region has no usable boundary.")); continue; }
    const rotated = avoidInternalDiagonals(em, comp, loop);
    addFan(parts, rotated.map((v) => p(em, v)), smooth); made += loop.length - 2;
    if (loop.length > 3 || comp.size > 1) warnings.push(new MeshEditWarning("DISSOLVE_FACES_RETRIANGULATED", "Dissolved face region was represented as deterministic triangles by the triangle-only editable mesh."));
  }
  const mesh = build(parts), resultFace = selection("face", Array.from({ length: made }, (_, i) => start + i)); tint(mesh, Array.from({ length: mesh.faceCount }, (_, i) => i));
  const out = { mesh, descendants: { resultFace } };
  return warnings.length ? { ...out, warnings } : out;
}

function components(em: EditableMesh, selected: ReadonlySet<number>): Set<number>[] {
  const k = em.gpu.halfEdgeKernel, pending = new Set(selected), out: Set<number>[] = [];
  while (pending.size) {
    const first = pending.values().next().value as number, comp = new Set<number>(), stack = [first]; pending.delete(first);
    while (stack.length) {
      const f = stack.pop()!; comp.add(f);
      for (const e of k.faceEdges.slice(f * 3, f * 3 + 3)) for (const n of [k.edgeFaceA[e], k.edgeFaceB[e]]) if (selected.has(n) && pending.delete(n)) stack.push(n);
    }
    out.push(comp);
  }
  return out;
}

function boundaryLoop(em: EditableMesh, comp: ReadonlySet<number>): number[] {
  const k = em.gpu.halfEdgeKernel, adj = new Map<number, number[]>();
  for (const f of comp) for (let c = 0; c < 3; c++) {
    const e = k.faceEdges[f * 3 + c], a = k.edgeFaceA[e], b = k.edgeFaceB[e];
    if (comp.has(a) && comp.has(b)) continue;
    const va = k.edgeVertexA[e], vb = k.edgeVertexB[e]; add(adj, va, vb); add(adj, vb, va);
  }
  const starts = [...adj.keys()].sort((a, b) => a - b); if (starts.length < 3) return [];
  const out = [starts[0]], used = new Set<string>();
  while (out.length <= starts.length) {
    const v = out[out.length - 1], prev = out[out.length - 2], next = (adj.get(v) ?? []).filter((n) => n !== prev && !used.has(edgeKey(v, n))).sort((a, b) => a - b)[0];
    if (next === undefined) break; used.add(edgeKey(v, next)); out.push(next); if (next === out[0]) { out.pop(); return out; }
  }
  return [];
}

function avoidInternalDiagonals(em: EditableMesh, comp: ReadonlySet<number>, loop: readonly number[]): number[] {
  const forbidden = internalEdges(em, comp);
  for (let r = 0; r < loop.length; r++) {
    const rotated = [...loop.slice(r), ...loop.slice(0, r)];
    let ok = true; for (let i = 2; i < rotated.length - 1; i++) if (forbidden.has(edgeKey(rotated[0], rotated[i]))) ok = false;
    if (ok) return rotated;
  }
  return [...loop];
}

function internalEdges(em: EditableMesh, comp: ReadonlySet<number>): Set<string> {
  const k = em.gpu.halfEdgeKernel, out = new Set<string>();
  for (const f of comp) for (const e of k.faceEdges.slice(f * 3, f * 3 + 3)) if (comp.has(k.edgeFaceA[e]) && comp.has(k.edgeFaceB[e])) out.add(edgeKey(k.edgeVertexA[e], k.edgeVertexB[e]));
  return out;
}
function add(adj: Map<number, number[]>, a: number, b: number): void { adj.set(a, [...(adj.get(a) ?? []), b]); }
function edgeKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function orSmooth(em: EditableMesh, faces: ReadonlySet<number>): number { const k = em.gpu.halfEdgeKernel; for (const f of faces) if (k.useSmooth[f]) return 1; return 0; }
