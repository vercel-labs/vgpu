import { MeshEditError } from "../errors.ts";
import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addTri, build, center, key, p, type MeshParts, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface FillHoleOptions { readonly method?: "triangulate" | "ngon" | "beautify" }
export interface FillHoleResult { readonly mesh: EditableMesh; readonly descendants: { readonly newFaces: ElementSelection }; readonly warnings?: readonly MeshEditWarning[] }

export function fillHole(em: EditableMesh, boundary: ElementSelection, opts: FillHoleOptions = {}): FillHoleResult {
  requireLoop(boundary);
  const verts = loopVertices(em, boundary.indices), parts = copyMesh(em), warnings = nonPlanar(em, verts) ? [new MeshEditWarning("FILL_NON_PLANAR_BOUNDARY", "Hole boundary is not planar; triangulated fill was used.")] : [];
  if ((opts.method ?? "triangulate") !== "triangulate") warnings.push(new MeshEditWarning("FILL_HOLE_TRIANGULATED", `${opts.method} fill was represented as triangle fan by the triangle-only editable mesh.`));
  const smooth = 1, start = parts.faces.length, ps = verts.map((v) => p(em, v));
  for (let i = 1; i < ps.length - 1; i++) addTri(parts, ps[0], ps[i], ps[i + 1], smooth);
  const mesh = build(parts), faces = selection("face", range(start, parts.faces.length)); tint(mesh, range(0, mesh.faceCount));
  const out = { mesh, descendants: { newFaces: faces } };
  return warnings.length ? { ...out, warnings } : out;
}

function requireLoop(sel: ElementSelection): void {
  if (sel.domain !== "edge") throw new MeshEditError({ code: "WRONG_DOMAIN" });
  if (sel.count === 0) throw new MeshEditError({ code: "EMPTY_SELECTION" });
  if (!sel.ordered) throw new MeshEditError({ code: "NOT_ORDERED" });
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

function copyMesh(em: EditableMesh): MeshParts {
  const k = em.gpu.halfEdgeKernel, m: MeshParts = { positions: [], faces: [], useSmooth: [], sharp: new Set() };
  for (let f = 0; f < em.faceCount; f++) addTri(m, p(em, k.faceVertices[f * 3]), p(em, k.faceVertices[f * 3 + 1]), p(em, k.faceVertices[f * 3 + 2]), k.useSmooth[f]);
  for (let e = 0; e < em.edgeCount; e++) if (k.isSharp[e]) m.sharp.add(key(p(em, k.edgeVertexA[e]), p(em, k.edgeVertexB[e])));
  return m;
}

function nonPlanar(em: EditableMesh, verts: readonly number[]): boolean {
  if (verts.length < 4) return false;
  const ps = verts.map((v) => p(em, v)), n = cross(sub(ps[1], ps[0]), sub(ps[2], ps[0])), len = Math.hypot(n[0], n[1], n[2]) || 1;
  for (let i = 3; i < ps.length; i++) if (Math.abs(dot(n, sub(ps[i], ps[0])) / len) > 1e-4) return true;
  return false;
}

function sub(a: V, b: V): V { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V, b: V): V { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: V, b: V): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function range(a: number, b: number): number[] { return Array.from({ length: b - a }, (_, i) => a + i); }
function tint(em: EditableMesh, faces: readonly number[]): void { const n = em.gpu.halfEdgeKernel.faceNormals; for (const f of faces) n.set([0.577, 0.577, 0.577], f * 3); }
