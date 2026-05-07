import { MeshEditError } from "../errors.ts";
import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { edgeVerts, p } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";
import { subdivideEdges } from "./subdivide-edges.ts";

import { unwrapKernel } from "../kernel-handle.ts";
export interface LoopCutOptions { readonly cuts?: number; readonly slide?: number }
export interface LoopCutResult { readonly mesh: EditableMesh; readonly insertedLoop: ElementSelection; readonly warnings?: readonly MeshEditWarning[] }

export function loopCut(em: EditableMesh, seedEdge: number, opts: LoopCutOptions = {}): LoopCutResult {
  if (seedEdge < 0 || seedEdge >= em.edgeCount) throw new MeshEditError({ code: "EMPTY_SELECTION" });
  const loop = selection("edge", parallelRing(em, seedEdge), true);
  const result = subdivideEdges(em, loop, { cuts: opts.cuts ?? 1 });
  for (const e of result.newEdges.indices) unwrapKernel(result.mesh.gpu.halfEdgeKernel).isSharp[e] = 0;
  const insertedLoop = selection("edge", result.newEdges.indices, true);
  const warnings = loop.count <= 1 ? [new MeshEditWarning("LOOP_CUT_AMBIGUOUS_CONTINUATION", "Loop cut could not find an unambiguous continuation; only the seed edge was cut.", { domain: "edge", index: seedEdge })] : undefined;
  return warnings ? { mesh: result.mesh, insertedLoop, warnings } : { mesh: result.mesh, insertedLoop };
}

function parallelRing(em: EditableMesh, seed: number): number[] {
  const dir = edgeDir(em, seed), out: number[] = [];
  for (let e = 0; e < em.edgeCount; e++) {
    const d = edgeDir(em, e), dot = Math.abs(dir[0] * d[0] + dir[1] * d[1] + dir[2] * d[2]);
    if (dot > 0.999) out.push(e);
  }
  return out.length ? out : [seed];
}

function edgeDir(em: EditableMesh, e: number): readonly [number, number, number] {
  const [a, b] = edgeVerts(em, e), av = p(em, a), bv = p(em, b), d = [bv[0] - av[0], bv[1] - av[1], bv[2] - av[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}
