import { MeshEditError } from "../errors.ts";
import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addQuad, addTri, build, key, p, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface BridgeOptions { readonly twist?: number; readonly mode?: "faces" | "merge" }
export interface BridgeResult { readonly mesh: EditableMesh; readonly descendants: { readonly bridgeFaces: ElementSelection }; readonly chosenTwist: number; readonly warnings?: readonly MeshEditWarning[] }

export function bridge(em: EditableMesh, sel: ElementSelection, opts: BridgeOptions = {}): BridgeResult {
  requireLoops(sel);
  const [aEdges, bEdges] = splitLoops(em, sel.indices), a = loopVertices(em, aEdges), b = loopVertices(em, bEdges), warnings: MeshEditWarning[] = [];
  if (opts.mode === "merge") throw new MeshEditError({ code: "UNSUPPORTED_INPUT", message: "Bridge merge mode is not supported by the triangle-only editable mesh." });
  if (a.length !== b.length) warnings.push(new MeshEditWarning("BRIDGE_LOOP_LENGTH_MISMATCH", "Bridge loops have different lengths; modulo correspondence was used."));
  const twist = opts.twist ?? chooseTwist(em, a, b), parts = copyMesh(em), start = parts.faces.length, n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const a0 = p(em, a[i % a.length]), a1 = p(em, a[(i + 1) % a.length]), b1 = p(em, b[(i + 1 + twist) % b.length]), b0 = p(em, b[(i + twist) % b.length]);
    addQuad(parts, a0, a1, b1, b0, 1);
  }
  const mesh = build(parts), faces = selection("face", range(start, parts.faces.length)); tint(mesh, range(0, mesh.faceCount));
  const out = { mesh, descendants: { bridgeFaces: faces }, chosenTwist: mod(twist, b.length) };
  return warnings.length ? { ...out, warnings } : out;
}

function requireLoops(sel: ElementSelection): void {
  if (sel.domain !== "edge") throw new MeshEditError({ code: "WRONG_DOMAIN" });
  if (sel.count === 0) throw new MeshEditError({ code: "EMPTY_SELECTION" });
  if (!sel.ordered) throw new MeshEditError({ code: "NOT_ORDERED" });
}

function splitLoops(em: EditableMesh, edges: readonly number[]): [readonly number[], readonly number[]] {
  for (let i = 3; i <= edges.length - 3; i++) if (isLoop(em, edges.slice(0, i)) && isLoop(em, edges.slice(i))) return [edges.slice(0, i), edges.slice(i)];
  if (edges.length >= 6 && edges.length % 2 === 0) return [edges.slice(0, edges.length / 2), edges.slice(edges.length / 2)];
  throw new MeshEditError({ code: "AMBIGUOUS_TOPOLOGY" });
}

function isLoop(em: EditableMesh, edges: readonly number[]): boolean {
  try {
    const verts = loopVertices(em, edges), k = em.gpu.halfEdgeKernel, last = edges[edges.length - 1];
    return verts.length === edges.length && (k.edgeVertexA[last] === verts[0] || k.edgeVertexB[last] === verts[0]);
  } catch { return false; }
}

function loopVertices(em: EditableMesh, edges: readonly number[]): number[] {
  const k = em.gpu.halfEdgeKernel, out = [k.edgeVertexA[edges[0]], k.edgeVertexB[edges[0]]];
  for (let i = 1; i < edges.length; i++) {
    const a = k.edgeVertexA[edges[i]], b = k.edgeVertexB[edges[i]], tail = out[out.length - 1];
    if (a === tail) out.push(b); else if (b === tail) out.push(a); else if (a === out[0]) out.unshift(b); else if (b === out[0]) out.unshift(a); else throw new MeshEditError({ code: "AMBIGUOUS_TOPOLOGY" });
  }
  if (out[0] === out[out.length - 1]) out.pop();
  if (out.length < 3) throw new MeshEditError({ code: "DEGENERATE_RESULT" });
  return out;
}

function chooseTwist(em: EditableMesh, a: readonly number[], b: readonly number[]): number {
  let best = 0, bestScore = Infinity;
  for (let t = 0; t < b.length; t++) {
    let score = 0; for (let i = 0; i < a.length; i++) score += dist2(p(em, a[i]), p(em, b[(i + t) % b.length]));
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && b[t] < b[best])) { best = t; bestScore = score; }
  }
  return best;
}

function copyMesh(em: EditableMesh): MeshParts {
  const k = em.gpu.halfEdgeKernel, m: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() };
  for (let f = 0; f < em.faceCount; f++) addTri(m, p(em, k.faceVertices[f * 3]), p(em, k.faceVertices[f * 3 + 1]), p(em, k.faceVertices[f * 3 + 2]), k.useSmooth[f]);
  for (let e = 0; e < em.edgeCount; e++) if (k.isSharp[e]) m.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e])));
  return m;
}

function dist2(a: V, b: V): number { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function mod(a: number, b: number): number { return ((a % b) + b) % b; }
function range(a: number, b: number): number[] { return Array.from({ length: b - a }, (_, i) => a + i); }
function tint(em: EditableMesh, faces: readonly number[]): void { const n = em.gpu.halfEdgeKernel.faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
