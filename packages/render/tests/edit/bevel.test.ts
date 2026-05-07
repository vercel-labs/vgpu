import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";
import { EditableMesh, MeshEditError, bevel, toEditable } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { makeTestPyramid } from "./fixtures/test-pyramid.ts";

const tri = (positions: number[], indices: number[], sharpEdges?: Uint8Array) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices), sharpEdges });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const euler = (em: ReturnType<typeof tetra>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("bevel", () => {
  test("bevels selected edges deterministically", () => {
    const em = tetra();
    const result = bevel(em, em.edges.all(), { offset: 0.1 });
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.faceCount).toBeGreaterThan(em.faceCount);
    expect(result.descendants.newEdges.count).toBeGreaterThan(0);
    expect(result.descendants.newFaces.count).toBeGreaterThan(0);
  });

  test("markSharp defaults true on new bevel boundary edges", () => {
    const em = tetra();
    const result = bevel(em, em.edges.byIndex([0]), { offset: 0.1 });
    expect(result.descendants.newEdges.indices.some((e) => result.mesh.gpu.halfEdgeKernel.isSharp[e] === 1)).toBe(true);
  });

  test("markSharp false leaves bevel descendants smooth", () => {
    const em = tetra();
    const result = bevel(em, em.edges.byIndex([0]), { offset: 0.1, markSharp: false });
    expect(result.descendants.newEdges.indices.every((e) => result.mesh.gpu.halfEdgeKernel.isSharp[e] === 0)).toBe(true);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => bevel(em, em.edges.none(), { offset: 0.1 })).toThrow(MeshEditError);
    try { bevel(em, em.edges.none(), { offset: 0.1 }); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = tetra(), sel = em.edges.byIndex([0, 1]);
    expect(bevel(em, sel, { offset: 0.1 }).descendants).toEqual(bevel(em, sel, { offset: 0.1 }).descendants);
  });

  test("bevels a hard-edged polygonal pyramid fixture and bakes", async () => {
    // Test-only pyramid fixture covers the user-priority shape until Mesh.cone lands in the geometry-primitives PR.
    const { device } = await App.create({ adapter: createMockAdapter() });
    try {
      const pyramid = makeTestPyramid(device);
      const em = toEditable(pyramid);
      const sharp = em.edges.where((e) => e.isSharp);
      const result = bevel(em, sharp, { offset: 0.1, segments: 1 });
      const beveledPyramid = result.mesh.toRenderMesh({ device });
      expect(beveledPyramid.vertexCount).toBeGreaterThan(0);
      expect(result.descendants.newEdges.count).toBeGreaterThan(0);
      expect(result.descendants.newFaces.count).toBeGreaterThan(0);
    } finally { device.destroy(); }
  });
});
