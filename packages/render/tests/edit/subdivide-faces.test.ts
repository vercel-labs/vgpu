import { EditableMesh, MeshEditError, subdivideFaces } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./helpers.ts";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const euler = (em: ReturnType<typeof tetra>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("subdivideFaces", () => {
  test("subdivides all faces and preserves manifold Euler characteristic", () => {
    const em = tetra(), result = subdivideFaces(em, em.faces.all(), { cuts: 1 });
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(result.mesh.faceCount).toBe(em.faceCount * 4);
  });

  test("returns replacement faces and new edges", () => {
    const em = tetra(), result = subdivideFaces(em, em.faces.byIndex([0]), { cuts: 1 });
    expect(result.newFaces.indices).toEqual([0, 1, 2, 3]);
    expect(result.newEdges.count).toBe(9);
  });

  test("keeps interior edges smooth and inherits source face smoothness", () => {
    const em = tetra(); unwrapKernel(em.gpu.halfEdgeKernel).isSharp.fill(0); unwrapKernel(em.gpu.halfEdgeKernel).isSharp[0] = 1; unwrapKernel(em.gpu.halfEdgeKernel).useSmooth[0] = 0;
    const result = subdivideFaces(em, em.faces.byIndex([0]), { cuts: 1 });
    expect(result.newFaces.indices.every((f) => unwrapKernel(result.mesh.gpu.halfEdgeKernel).useSmooth[f] === 0)).toBe(true);
    expect(result.newEdges.indices.some((e) => unwrapKernel(result.mesh.gpu.halfEdgeKernel).isSharp[e] === 0)).toBe(true);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => subdivideFaces(em, em.faces.none())).toThrow(MeshEditError);
    try { subdivideFaces(em, em.faces.none()); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = tetra(), sel = em.faces.all(), a = subdivideFaces(em, sel), b = subdivideFaces(em, sel);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });
});
