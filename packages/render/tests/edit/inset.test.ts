import { EditableMesh, MeshEditError, inset } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const euler = (em: ReturnType<typeof tetra>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("inset", () => {
  test("insets selected faces and keeps closed meshes manifold", () => {
    const em = tetra();
    const result = inset(em, em.faces.byIndex([0]), { thickness: 0.25 });
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(result.mesh.faceCount).toBe(em.faceCount + 6);
  });

  test("returns inset face, boundary faces, and rim edge descendants", () => {
    const em = tetra();
    const result = inset(em, em.faces.byIndex([0]), { thickness: 0.2 });
    expect(result.descendants.insetFaces.indices).toEqual([3]);
    expect(result.descendants.boundaryFaces.indices).toEqual([4, 5, 6, 7, 8, 9]);
    expect(result.descendants.rimEdges.count).toBeGreaterThan(0);
  });

  test("propagates smoothness transparently", () => {
    const em = tetra();
    const result = inset(em, em.faces.byIndex([0]), { thickness: 0.2 });
    expect(result.descendants.insetFaces.indices.every((f) => result.mesh.gpu.halfEdgeKernel.useSmooth[f] === 1)).toBe(true);
    expect(result.descendants.boundaryFaces.indices.every((f) => result.mesh.gpu.halfEdgeKernel.useSmooth[f] === 1)).toBe(true);
  });

  test("emits warning when thickness is clamped", () => {
    const em = tetra();
    expect(inset(em, em.faces.byIndex([0]), { thickness: 2 }).warnings?.[0].code).toBe("INSET_OVERLAP_CLAMPED");
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => inset(em, em.faces.none(), { thickness: 0.1 })).toThrow(MeshEditError);
    try { inset(em, em.faces.none(), { thickness: 0.1 }); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = tetra(), sel = em.faces.byIndex([0]);
    expect(inset(em, sel, { thickness: 0.1 }).descendants).toEqual(inset(em, sel, { thickness: 0.1 }).descendants);
  });
});
