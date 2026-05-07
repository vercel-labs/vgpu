import { MeshEditWarning } from "../warnings.ts";
import { selection } from "../selection.ts";
import { build, copyWithoutFaces, requireSelection, tint } from "../operator-utils.ts";
import { dissolveFaces } from "./dissolve-faces.ts";
import type { EditableMesh, ElementSelection } from "../types.ts";

import { unwrapKernel } from "../kernel-handle.ts";
export interface DissolveVerticesOptions { readonly useFaceSplit?: boolean; readonly useBoundaryTear?: boolean }
export interface DissolveVerticesResult { readonly mesh: EditableMesh; readonly surroundingFaces: ElementSelection; readonly warnings?: readonly MeshEditWarning[] }

export function dissolveVertices(em: EditableMesh, vertices: ElementSelection, _opts: DissolveVerticesOptions = {}): DissolveVerticesResult {
  requireSelection(vertices, "vertex");
  const k = unwrapKernel(em.gpu.halfEdgeKernel), faces = new Set<number>(), warnings: MeshEditWarning[] = [];
  for (const v of vertices.indices) {
    if (isBoundaryVertex(em, v)) { warnings.push(new MeshEditWarning("NON_MANIFOLD_VERTEX_SKIPPED", "Boundary vertex cannot be dissolved into a closed surrounding face.", { domain: "vertex", index: v })); continue; }
    for (let f = 0; f < em.faceCount; f++) if (k.faceVertices.slice(f * 3, f * 3 + 3).includes(v)) faces.add(f);
  }
  if (!faces.size) {
    const mesh = build(copyWithoutFaces(em, new Set())); tint(mesh, Array.from({ length: mesh.faceCount }, (_, i) => i));
    const out = { mesh, surroundingFaces: selection("face", []) };
    return warnings.length ? { ...out, warnings } : out;
  }
  const dissolved = dissolveFaces(em, selection("face", [...faces]));
  const out = { mesh: dissolved.mesh, surroundingFaces: dissolved.resultFace };
  const allWarnings = [...warnings, ...(dissolved.warnings ?? [])];
  return allWarnings.length ? { ...out, warnings: allWarnings } : out;
}

function isBoundaryVertex(em: EditableMesh, v: number): boolean {
  const k = unwrapKernel(em.gpu.halfEdgeKernel);
  for (let e = 0; e < em.edgeCount; e++) if ((k.edgeVertexA[e] === v || k.edgeVertexB[e] === v) && k.edgeFaceB[e] < 0) return true;
  return false;
}
