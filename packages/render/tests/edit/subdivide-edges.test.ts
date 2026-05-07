import { EditableMesh, MeshEditError, subdivideEdges } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const cube = () => tri([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5], [1, 2, 6, 1, 6, 5, 4, 7, 3, 4, 3, 0, 3, 7, 6, 3, 6, 2, 4, 0, 1, 4, 1, 5, 4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2]);
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

  test("two cuts on all tetrahedron edges creates a regular three-way split", () => {
    const em = tetra(), result = subdivideEdges(em, em.edges.all(), { cuts: 2 });
    expect(result.mesh.vertexCount).toBe(20);
    expect(result.mesh.edgeCount).toBe(54);
    expect(result.mesh.faceCount).toBe(36);
    expect(result.newVertices.count).toBe(12);
    expect(result.newEdges.count).toBe(18);
    expect(euler(result.mesh)).toBe(2);
  });

  test("two cuts on one tetrahedron edge only subdivides incident faces", () => {
    const em = tetra(), result = subdivideEdges(em, em.edges.byIndex([0]), { cuts: 2 });
    expect(result.mesh.vertexCount).toBe(6);
    expect(result.mesh.faceCount).toBe(8);
    expect(result.newVertices.count).toBe(2);
    expect(result.newEdges.count).toBe(3);
  });

  test("three cuts on all cube edges follows the triangular grid formula", () => {
    const em = cube(), result = subdivideEdges(em, em.edges.all(), { cuts: 3 });
    expect(result.mesh.vertexCount).toBe(98);
    expect(result.mesh.edgeCount).toBe(288);
    expect(result.mesh.faceCount).toBe(192);
    expect(euler(result.mesh)).toBe(2);
  });

  test("zero cuts clamps to the one-cut behavior", () => {
    const em = tetra(), result = subdivideEdges(em, em.edges.all(), { cuts: 0 });
    expect(result.newVertices.count).toBe(em.edgeCount);
    expect(result.mesh.faceCount).toBe(16);
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
