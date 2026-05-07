import { MeshEditError, fillHole } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { openCube, topHoleLoop } from "./fixtures/connectivity.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const euler = (em: ReturnType<typeof openCube>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("fillHole", () => {
  test("fills an N-gon hole with N-2 triangles and closes the manifold", () => {
    const em = openCube(), boundary = topHoleLoop(em), result = fillHole(em, boundary);
    expect(result.mesh.faceCount).toBe(em.faceCount + boundary.count - 2);
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
  });

  test("returns new face descendants", () => {
    const em = openCube(), result = fillHole(em, topHoleLoop(em));
    expect(result.newFaces.domain).toBe("face");
    expect(result.newFaces.indices).toEqual([em.faceCount, em.faceCount + 1]);
  });

  test("preserves boundary sharp edges and makes new faces smooth", () => {
    const em = openCube(), boundary = topHoleLoop(em); for (const e of boundary.indices) unwrapKernel(em.gpu.halfEdgeKernel).isSharp[e] = 1;
    const result = fillHole(em, boundary), k = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.newFaces.indices.every((f) => k.useSmooth[f] === 1)).toBe(true);
    expect(result.mesh.hardEdges.count).toBeGreaterThanOrEqual(boundary.count);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = openCube(), none = em.edges.none();
    expect(() => fillHole(em, none)).toThrow(MeshEditError);
    try { fillHole(em, none); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("ngon method emits deterministic triangle-kernel warning", () => {
    const em = openCube(), result = fillHole(em, topHoleLoop(em), { method: "ngon" });
    expect(result.warnings?.map((w) => w.code)).toContain("FILL_HOLE_TRIANGULATED");
  });

  test("is deterministic for repeated inputs", () => {
    const em = openCube(), sel = topHoleLoop(em), a = fillHole(em, sel), b = fillHole(em, sel);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });
});
