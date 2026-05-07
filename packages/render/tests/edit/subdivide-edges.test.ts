import { EditableMesh, MeshEditError, subdivideEdges } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const euler = (em: ReturnType<typeof tetra>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("subdivideEdges", () => {
  test("subdivides all tetrahedron edges and preserves manifold Euler characteristic", () => {
    const em = tetra(), result = subdivideEdges(em, em.edges.all(), { cuts: 1 });
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(result.mesh.faceCount).toBe(16);
  });

  test("one cut adds one vertex and two child edges per selected edge", () => {
    const em = tetra(), result = subdivideEdges(em, em.edges.all(), { cuts: 1 });
    expect(result.newVertices.count).toBe(em.edgeCount);
    expect(result.newEdges.count).toBe(em.edgeCount * 2);
  });

  test("returns deterministic descendant selections", () => {
    const em = tetra(), a = subdivideEdges(em, em.edges.all()), b = subdivideEdges(em, em.edges.all());
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });

  test("preserves sharpness on every child of a sharp parent edge", () => {
    const em = tetra(); unwrapKernel(em.gpu.halfEdgeKernel).isSharp.fill(0); unwrapKernel(em.gpu.halfEdgeKernel).isSharp[0] = 1;
    const result = subdivideEdges(em, em.edges.byIndex([0]), { cuts: 1 });
    expect(result.newEdges.indices.every((e) => unwrapKernel(result.mesh.gpu.halfEdgeKernel).isSharp[e] === 1)).toBe(true);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => subdivideEdges(em, em.edges.none())).toThrow(MeshEditError);
    try { subdivideEdges(em, em.edges.none()); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });
});
