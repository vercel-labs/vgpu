import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addTri, build, copyWithoutFaces, normal, p, requireSelection, tint, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface DissolveEdgesOptions { readonly useVerts?: boolean }
export interface DissolveEdgesResult { readonly mesh: EditableMesh; readonly descendants: { readonly mergedFaces: ElementSelection }; readonly warnings?: readonly MeshEditWarning[] }

export function dissolveEdges(em: EditableMesh, edges: ElementSelection, _opts: DissolveEdgesOptions = {}): DissolveEdgesResult {
  requireSelection(edges, "edge");
  const k = em.gpu.halfEdgeKernel, jobs: Job[] = [], drop = new Set<number>(), warnings: MeshEditWarning[] = [];
  for (const e of edges.indices) {
    const fa = k.edgeFaceA[e], fb = k.edgeFaceB[e];
    if (fa < 0 || fb < 0) { warnings.push(new MeshEditWarning("NON_MANIFOLD_EDGE_SKIPPED", "Boundary edge cannot be dissolved into a merged face.", { domain: "edge", index: e })); continue; }
    if (drop.has(fa) || drop.has(fb)) { warnings.push(new MeshEditWarning("NON_MANIFOLD_EDGE_SKIPPED", "Overlapping dissolve edge region was skipped.", { domain: "edge", index: e })); continue; }
    drop.add(fa); drop.add(fb); jobs.push({ edge: e, fa, fb });
  }
  const parts = copyWithoutFaces(em, drop), start = parts.faces.length;
  for (const job of jobs) addMergedQuad(em, parts, job);
  if (jobs.length) warnings.push(new MeshEditWarning("DISSOLVE_FACES_RETRIANGULATED", "Dissolved edge faces were represented with the opposite deterministic triangle diagonal."));
  const mesh = build(parts), mergedFaces = selection("face", Array.from({ length: jobs.length * 2 }, (_, i) => start + i)); tint(mesh, Array.from({ length: mesh.faceCount }, (_, i) => i));
  const out = { mesh, descendants: { mergedFaces } };
  return warnings.length ? { ...out, warnings } : out;
}

interface Job { readonly edge: number; readonly fa: number; readonly fb: number }

function addMergedQuad(em: EditableMesh, m: MeshParts, job: Job): void {
  const k = em.gpu.halfEdgeKernel, a = k.edgeVertexA[job.edge], b = k.edgeVertexB[job.edge], c = other(k.faceVertices.slice(job.fa * 3, job.fa * 3 + 3), a, b), d = other(k.faceVertices.slice(job.fb * 3, job.fb * 3 + 3), a, b);
  const smooth = k.useSmooth[job.fa] || k.useSmooth[job.fb] ? 1 : 0, target = avg(normal([p(em, a), p(em, b), p(em, c)]), normal([p(em, b), p(em, a), p(em, d)]));
  addOrientedTri(m, p(em, c), p(em, d), p(em, a), target, smooth);
  addOrientedTri(m, p(em, d), p(em, c), p(em, b), target, smooth);
}

function addOrientedTri(m: MeshParts, a: V, b: V, c: V, target: V, smooth: number): void {
  const n = normal([a, b, c]);
  if (dot(n, target) < 0) addTri(m, a, c, b, smooth); else addTri(m, a, b, c, smooth);
}
function other(vs: ArrayLike<number>, a: number, b: number): number { for (let i = 0; i < vs.length; i++) if (vs[i] !== a && vs[i] !== b) return vs[i]; return a; }
function avg(a: V, b: V): V { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function dot(a: V, b: V): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
