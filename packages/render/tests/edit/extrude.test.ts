import { EditableMesh, MeshEditError, extrude } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const euler = (em: ReturnType<typeof tetra>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("extrude", () => {
  test("extrudes selected faces and keeps closed meshes manifold", () => {
    const em = tetra();
    const result = extrude(em, em.faces.byIndex([0]), { distance: 0.4 });
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(result.mesh.faceCount).toBe(em.faceCount + 6);
  });

  test("returns side faces, cap faces, side edges, and cap ring descendants", () => {
    const em = tetra();
    const result = extrude(em, em.faces.byIndex([0]), { distance: 0.25 });
    expect(result.descendants.sideFaces.indices).toEqual([4, 5, 6, 7, 8, 9]);
    expect(result.descendants.capFaces.indices).toEqual([3]);
    expect(result.descendants.sideEdges.count).toBeGreaterThan(0);
    expect(result.descendants.capRing.count).toBe(3);
  });

  test("marks side-face boundary edges sharp and cap inherits smoothness", () => {
    const em = tetra();
    const result = extrude(em, em.faces.byIndex([0]), { distance: 0.4 });
    expect(result.descendants.capRing.indices.every((e) => result.mesh.gpu.halfEdgeKernel.isSharp[e] === 1)).toBe(true);
    expect(result.mesh.gpu.halfEdgeKernel.useSmooth[result.descendants.capFaces.indices[0]]).toBe(1);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => extrude(em, em.faces.none(), { distance: 1 })).toThrow(MeshEditError);
    try { extrude(em, em.faces.none(), { distance: 1 }); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = tetra(), sel = em.faces.byIndex([0]);
    const a = extrude(em, sel, { distance: 0.2 }), b = extrude(em, sel, { distance: 0.2 });
    expect([a.mesh.vertexCount, a.mesh.edgeCount, a.mesh.faceCount]).toEqual([b.mesh.vertexCount, b.mesh.edgeCount, b.mesh.faceCount]);
    expect(a.descendants).toEqual(b.descendants);
  });
});
