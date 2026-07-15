import { EditableMesh, MeshEditError, extrude } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./helpers.ts";

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

  test("returns side faces, cap faces, and boundary edge descendants", () => {
    const em = tetra();
    const result = extrude(em, em.faces.byIndex([0]), { distance: 0.25 });
    expect(result.sideFaces.indices).toEqual([4, 5, 6, 7, 8, 9]);
    expect(result.capFaces.indices).toEqual([3]);
    expect(result.boundaryEdges.count).toBe(3);
  });

  test("marks side-face boundary edges sharp and cap inherits smoothness", () => {
    const em = tetra();
    const result = extrude(em, em.faces.byIndex([0]), { distance: 0.4 });
    expect(result.boundaryEdges.indices.every((e) => unwrapKernel(result.mesh.gpu.halfEdgeKernel).isSharp[e] === 1)).toBe(true);
    expect(unwrapKernel(result.mesh.gpu.halfEdgeKernel).useSmooth[result.capFaces.indices[0]]).toBe(1);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => extrude(em, em.faces.none(), { distance: 1 })).toThrow(MeshEditError);
    try { extrude(em, em.faces.none(), { distance: 1 }); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = tetra(), sel = em.faces.byIndex([0]);
    const a = extrude(em, sel, { distance: 0.2 }), b = extrude(em, sel, { distance: 0.2 });
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
    expect({ sideFaces: a.sideFaces, capFaces: a.capFaces, boundaryEdges: a.boundaryEdges }).toEqual({ sideFaces: b.sideFaces, capFaces: b.capFaces, boundaryEdges: b.boundaryEdges });
  });
});
