import { edgeView, edgesOfVertex, faceView, vertexView } from "./half-edge-views.ts";
import { MeshScoredSelection, selection } from "./selection.ts";
import type { HalfEdgeKernel } from "./half-edge-kernel.ts";
import type { ElementDomain, ElementSelection, ElementSet, ElementView } from "./types.ts";

export function makeElementSet<D extends "vertex" | "edge" | "face">(k: HalfEdgeKernel, domain: D): ElementSet<D> {
  const count = domain === "vertex" ? k.vertexCount : domain === "edge" ? k.edgeCount : k.faceCount;
  const view = (i: number) => (domain === "vertex" ? vertexView(k, i) : domain === "edge" ? edgeView(k, i) : faceView(k, i)) as ElementView<D>;
  const neighbors = (i: number) => neighborIndices(k, domain, i);
  return {
    domain, count,
    where(pred) { return selection(domain, range(count).filter((i) => pred(view(i)))); },
    scoreBy(score) { return new MeshScoredSelection(domain, range(count).map((i) => ({ index: i, score: score(view(i)) }))); },
    byIndex(indices) { return selection(domain, indices.filter((i) => i >= 0 && i < count)); },
    all() { return selection(domain, range(count)); },
    none() { return selection(domain, []); },
    loop(seed: number) { return selection("edge", walk(k, seed), true) as never; },
    ring(seed: number) { return selection("edge", walk(k, seed), true) as never; },
    grow(sel, layers = 1) { let cur = new Set(sel.indices); for (let l = 0; l < layers; l++) for (const i of [...cur]) for (const n of neighbors(i)) cur.add(n); return selection(domain, [...cur]); },
    shrink(sel, layers = 1) { let cur = new Set(sel.indices); for (let l = 0; l < layers; l++) for (const i of [...cur]) if (neighbors(i).some((n) => !cur.has(n))) cur.delete(i); return selection(domain, [...cur]); },
    boundaryOf(sel) { return boundary(k, sel); },
    connectedComponentOf(seed) { const seen = new Set<number>([seed]), q = [seed]; for (const i of q) for (const n of neighbors(i)) if (!seen.has(n)) { seen.add(n); q.push(n); } return selection(domain, [...seen]); },
  };
}

function neighborIndices(k: HalfEdgeKernel, d: ElementDomain, i: number): number[] {
  if (d === "vertex") return edgesOfVertex(k, i).map((e) => k.edgeVertexA[e] === i ? k.edgeVertexB[e] : k.edgeVertexA[e]);
  if (d === "edge") return [...new Set([k.edgeVertexA[i], k.edgeVertexB[i]].flatMap((v) => edgesOfVertex(k, v)).filter((e) => e !== i))];
  const out = new Set<number>(); for (const e of k.faceEdges.slice(i * 3, i * 3 + 3)) { const a = k.edgeFaceA[e], b = k.edgeFaceB[e]; if (a !== i && a >= 0) out.add(a); if (b !== i && b >= 0) out.add(b); } return [...out];
}

function boundary(k: HalfEdgeKernel, sel: ElementSelection): ElementSelection {
  const s = new Set(sel.indices), out: number[] = [];
  switch (sel.domain) {
    case "face": for (let e = 0; e < k.edgeCount; e++) if (s.has(k.edgeFaceA[e]) !== s.has(k.edgeFaceB[e])) out.push(e); break;
    case "vertex": for (let e = 0; e < k.edgeCount; e++) if (s.has(k.edgeVertexA[e]) !== s.has(k.edgeVertexB[e])) out.push(e); break;
    case "edge": out.push(...sel.indices); break;
  }
  return selection("edge", out);
}

function walk(k: HalfEdgeKernel, seed: number): number[] {
  const seen = new Set<number>([seed]), q = [seed]; for (const i of q) for (const n of neighborIndices(k, "edge", i)) if (!seen.has(n)) { seen.add(n); q.push(n); } return q;
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
