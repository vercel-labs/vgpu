import { MeshEditError, mergeByDistance } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { edgeBetween, mergeDuplicateTetra } from "./fixtures/cleanup.ts";
import type { EditableMeshValue } from "@vgpu/render/edit";

const euler = (em: EditableMeshValue) => em.vertexCount - em.edgeCount + em.faceCount;
const signature = (em: EditableMeshValue) => [em.vertexCount, em.edgeCount, em.faceCount, ...Array.from(em.gpu.halfEdgeKernel.positions), ...Array.from(em.gpu.halfEdgeKernel.faceVertices), ...Array.from(em.gpu.halfEdgeKernel.isSharp)];

describe("mergeByDistance", () => {
  test("welds selected vertices within the threshold", () => {
    const em = mergeDuplicateTetra(), result = mergeByDistance(em, em.vertices.byIndex([0, 4]), { threshold: 0.3 });
    expect(result.mesh.vertexCount).toBe(4);
    expect(result.descendants.weldedCount).toBe(1);
    expect(result.descendants.mergeMap.get(4)).toBe(result.descendants.mergeMap.get(0));
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
  });

  test("OR-merges sharpness onto survivor edges", () => {
    const em = mergeDuplicateTetra(), result = mergeByDistance(em, em.vertices.byIndex([0, 4]), { threshold: 0.3 });
    expect(result.mesh.gpu.halfEdgeKernel.isSharp[edgeBetween(result.mesh, 0, 2)]).toBe(1);
  });

  test("throws EMPTY_SELECTION for empty vertex input", () => {
    const em = mergeDuplicateTetra();
    expect(() => mergeByDistance(em, em.vertices.none())).toThrow(MeshEditError);
    try { mergeByDistance(em, em.vertices.none()); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic", () => {
    const em = mergeDuplicateTetra(), sel = em.vertices.byIndex([0, 4]);
    const a = mergeByDistance(em, sel, { threshold: 0.3 }), b = mergeByDistance(em, sel, { threshold: 0.3 });
    expect(signature(a.mesh)).toEqual(signature(b.mesh));
    expect([...a.descendants.mergeMap]).toEqual([...b.descendants.mergeMap]);
  });
});
