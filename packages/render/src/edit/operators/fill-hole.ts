import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { addTri, build, copyMesh, loopVertices, p, range, requireLoop, tint, type V } from "../operator-utils.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

export interface FillHoleOptions { readonly method?: "triangulate" | "ngon" | "beautify" }
export interface FillHoleResult { readonly mesh: EditableMesh; readonly newFaces: ElementSelection; readonly warnings?: readonly MeshEditWarning[] }

export function fillHole(em: EditableMesh, boundary: ElementSelection, opts: FillHoleOptions = {}): FillHoleResult {
  requireLoop(boundary);
  const verts = loopVertices(em, boundary.indices), parts = copyMesh(em), warnings = nonPlanar(em, verts) ? [new MeshEditWarning("FILL_NON_PLANAR_BOUNDARY", "Hole boundary is not planar; triangulated fill was used.")] : [];
  if ((opts.method ?? "triangulate") !== "triangulate") warnings.push(new MeshEditWarning("FILL_HOLE_TRIANGULATED", `${opts.method} fill was represented as triangle fan by the triangle-only editable mesh.`));
  const start = parts.faces.length, ps = verts.map((v) => p(em, v));
  for (let i = 1; i < ps.length - 1; i++) addTri(parts, ps[0], ps[i], ps[i + 1], 1);
  const mesh = build(parts), faces = selection("face", range(start, parts.faces.length)); tint(mesh, range(0, mesh.faceCount));
  const out = { mesh, newFaces: faces };
  return warnings.length ? { ...out, warnings } : out;
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
