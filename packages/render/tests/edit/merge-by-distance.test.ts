import { MeshEditError, mergeByDistance } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { edgeBetween, mergeDuplicateTetra } from "./fixtures/cleanup.ts";
import type { EditableMeshValue } from "@vgpu/render/edit";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const euler = (em: EditableMeshValue) => em.vertexCount - em.edgeCount + em.faceCount;

describe("mergeByDistance", () => {
  test("welds selected vertices within the threshold", () => {
    const em = mergeDuplicateTetra(), result = mergeByDistance(em, { selection: em.vertices.byIndex([0, 4]), threshold: 0.3 });
    expect(result.mesh.vertexCount).toBe(4);
    expect(result.weldedCount).toBe(1);
    expect(result.mergeMap.get(4)).toBe(result.mergeMap.get(0));
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
  });

  test("OR-merges sharpness onto survivor edges", () => {
    const em = mergeDuplicateTetra(), result = mergeByDistance(em, { selection: em.vertices.byIndex([0, 4]), threshold: 0.3 });
    expect(unwrapKernel(result.mesh.gpu.halfEdgeKernel).isSharp[edgeBetween(result.mesh, 0, 2)]).toBe(1);
  });

  test("throws EMPTY_SELECTION for empty vertex input", () => {
    const em = mergeDuplicateTetra();
    expect(() => mergeByDistance(em, { selection: em.vertices.none() })).toThrow(MeshEditError);
    try { mergeByDistance(em, { selection: em.vertices.none() }); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic", () => {
    const em = mergeDuplicateTetra(), sel = em.vertices.byIndex([0, 4]);
    const a = mergeByDistance(em, { selection: sel, threshold: 0.3 }), b = mergeByDistance(em, { selection: sel, threshold: 0.3 });
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
    expect([...a.mergeMap]).toEqual([...b.mergeMap]);
  });
});
