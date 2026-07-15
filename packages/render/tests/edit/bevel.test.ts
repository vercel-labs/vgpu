import { createMockAdapter } from "@vgpu/adapter-mock";

import { EditableMesh, MeshEditError, bevel, toEditable } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { makeTestPyramid } from "./fixtures/test-pyramid.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const tri = (positions: number[], indices: number[], sharpEdges?: Uint8Array) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices), sharpEdges });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const euler = (em: ReturnType<typeof tetra>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("bevel", () => {
  test("bevels selected edges deterministically", () => {
    const em = tetra();
    const result = bevel(em, em.edges.all(), { offset: 0.1 });
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.faceCount).toBeGreaterThan(em.faceCount);
    expect(result.newFaces.count).toBeGreaterThan(0);
    expect(result.originalFaces.count).toBeGreaterThan(0);
    expect(result.profileLoops[0].count).toBeGreaterThan(0);
  });

  test("markSharp marks bevel strip rims but not profile-loop connectors", () => {
    const em = tetra(), result = bevel(em, em.edges.byIndex([0]), { offset: 0.1 }), k = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    const profile = new Set(result.profileLoops.flatMap((loop) => loop.indices));
    const rims = result.mesh.edges.boundaryOf(result.newFaces).indices.filter((e) => !profile.has(e));
    expect(rims.length).toBeGreaterThan(0);
    expect(rims.every((e) => k.isSharp[e] === 1)).toBe(true);
    expect([...profile].every((e) => k.isSharp[e] === 0)).toBe(true);
  });

  test("markSharp false leaves bevel rims smooth", () => {
    const em = tetra();
    const result = bevel(em, em.edges.byIndex([0]), { offset: 0.1, markSharp: false });
    const k = unwrapKernel(result.mesh.gpu.halfEdgeKernel), profile = new Set(result.profileLoops.flatMap((loop) => loop.indices));
    const rims = result.mesh.edges.boundaryOf(result.newFaces).indices.filter((e) => !profile.has(e));
    expect(rims.every((e) => k.isSharp[e] === 0)).toBe(true);
  });

  test("segments greater than one warns that v1 clamps segments", () => {
    const em = tetra(), result = bevel(em, em.edges.byIndex([0]), { offset: 0.1, segments: 3 });
    expect(result.warnings?.[0]?.code).toBe("BEVEL_SEGMENTS_CLAMPED");
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => bevel(em, em.edges.none(), { offset: 0.1 })).toThrow(MeshEditError);
  });

  test("is deterministic for repeated inputs", () => {
    const em = tetra(), sel = em.edges.byIndex([0, 1]);
    const a = bevel(em, sel, { offset: 0.1 }), b = bevel(em, sel, { offset: 0.1 });
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
    expect({ newFaces: a.newFaces, originalFaces: a.originalFaces, profileLoops: a.profileLoops }).toEqual({ newFaces: b.newFaces, originalFaces: b.originalFaces, profileLoops: b.profileLoops });
  });

  test("works on the headline pyramid scene", async () => {
    const adapter = createMockAdapter();
    const device = await adapter.requestDevice();
    const pyramid = makeTestPyramid(device), em = toEditable(pyramid);
    const result = bevel(em, em.edges.where((e) => e.isSharp), { offset: 0.1, segments: 1 });
    const beveledPyramid = result.mesh.toRenderMesh({ device: device });
    expect(beveledPyramid.vertexCount).toBeGreaterThan(0);
    expect(result.newFaces.count).toBeGreaterThan(0);
  });
});
