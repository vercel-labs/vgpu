import { healManifold } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { edgeBetween, nonManifoldTetra } from "./fixtures/cleanup.ts";
import type { EditableMeshValue } from "@vgpu/render/edit";

const euler = (em: EditableMeshValue) => em.vertexCount - em.edgeCount + em.faceCount;
const edgeUseResidue = (em: EditableMeshValue) => {
  const counts = new Map<string, number>(), k = em.gpu.halfEdgeKernel;
  for (let f = 0; f < em.faceCount; f++) for (const e of k.faceEdges.slice(f * 3, f * 3 + 3)) counts.set(`${k.edgeVertexA[e]}:${k.edgeVertexB[e]}`, (counts.get(`${k.edgeVertexA[e]}:${k.edgeVertexB[e]}`) ?? 0) + 1);
  return [...counts.values()].some((v) => v !== 2);
};
const signature = (em: EditableMeshValue) => [em.vertexCount, em.edgeCount, em.faceCount, ...Array.from(em.gpu.halfEdgeKernel.faceVertices), ...Array.from(em.gpu.halfEdgeKernel.isSharp)];

describe("healManifold", () => {
  test("removes non-manifold residue and restores closed manifold topology", () => {
    const result = healManifold(nonManifoldTetra());
    expect(result.mesh.isManifold).toBe(true);
    expect(edgeUseResidue(result.mesh)).toBe(false);
    expect(euler(result.mesh)).toBe(2);
    expect(result.descendants.report.nonManifoldEdgesFixed).toBe(1);
  });

  test("preserves sharp flags on retained edges", () => {
    const em = nonManifoldTetra(); em.gpu.halfEdgeKernel.isSharp[edgeBetween(em, 2, 3)] = 1;
    const result = healManifold(em);
    expect(result.mesh.gpu.halfEdgeKernel.isSharp[edgeBetween(result.mesh, 2, 3)]).toBe(1);
  });

  test("is deterministic", () => {
    const a = healManifold(nonManifoldTetra()), b = healManifold(nonManifoldTetra());
    expect(signature(a.mesh)).toEqual(signature(b.mesh));
    expect(a.descendants.report).toEqual(b.descendants.report);
    expect(a.warnings).toEqual(b.warnings);
  });
});
