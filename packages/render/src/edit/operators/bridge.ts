import { MeshEditError } from "../errors.ts";
import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addQuad, build, copyMesh, loopVertices, p, range, requireLoop, tint, type V } from "../operator-utils.ts";
import { unwrapKernel } from "../kernel-handle.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface BridgeOptions { readonly twist?: number; readonly mode?: "faces" | "merge" }
export interface BridgeResult { readonly mesh: EditableMesh; readonly bridgeFaces: ElementSelection; readonly chosenTwist: number; readonly warnings?: readonly MeshEditWarning[] }

export function bridge(em: EditableMesh, sel: ElementSelection, opts: BridgeOptions = {}): BridgeResult {
  requireLoop(sel);
  const [aEdges, bEdges] = splitLoops(em, sel.indices), a = loopVertices(em, aEdges), b = loopVertices(em, bEdges), warnings: MeshEditWarning[] = [];
  if (opts.mode === "merge") throw new MeshEditError({ code: "UNSUPPORTED_INPUT", message: "Bridge merge mode is not supported by the triangle-only editable mesh." });
  if (a.length !== b.length) warnings.push(new MeshEditWarning("BRIDGE_LOOP_LENGTH_MISMATCH", "Bridge loops have different lengths; modulo correspondence was used."));
  const twist = opts.twist ?? chooseTwist(em, a, b), parts = copyMesh(em), start = parts.faces.length, n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const a0 = p(em, a[i % a.length]), a1 = p(em, a[(i + 1) % a.length]), b1 = p(em, b[(i + 1 + twist) % b.length]), b0 = p(em, b[(i + twist) % b.length]);
    addQuad(parts, a0, a1, b1, b0, 1);
  }
  const mesh = build(parts), faces = selection("face", range(start, parts.faces.length)); tint(mesh, range(0, mesh.faceCount));
  const out = { mesh, bridgeFaces: faces, chosenTwist: mod(twist, b.length) };
  return warnings.length ? { ...out, warnings } : out;
}

function splitLoops(em: EditableMesh, edges: readonly number[]): [readonly number[], readonly number[]] {
  for (let i = 3; i <= edges.length - 3; i++) if (isLoop(em, edges.slice(0, i)) && isLoop(em, edges.slice(i))) return [edges.slice(0, i), edges.slice(i)];
  if (edges.length >= 6 && edges.length % 2 === 0) return [edges.slice(0, edges.length / 2), edges.slice(edges.length / 2)];
  throw new MeshEditError({ code: "AMBIGUOUS_TOPOLOGY" });
}

function isLoop(em: EditableMesh, edges: readonly number[]): boolean {
  try {
    const verts = loopVertices(em, edges), k = unwrapKernel(em.gpu.halfEdgeKernel), last = edges[edges.length - 1];
    return verts.length === edges.length && (k.edgeVertexA[last] === verts[0] || k.edgeVertexB[last] === verts[0]);
  } catch { return false; }
}

function chooseTwist(em: EditableMesh, a: readonly number[], b: readonly number[]): number {
  let best = 0, bestScore = Infinity;
  for (let t = 0; t < b.length; t++) {
    let score = 0; for (let i = 0; i < a.length; i++) score += dist2(p(em, a[i]), p(em, b[(i + t) % b.length]));
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && b[t] < b[best])) { best = t; bestScore = score; }
  }
  return best;
}

function dist2(a: V, b: V): number { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function mod(a: number, b: number): number { return ((a % b) + b) % b; }
