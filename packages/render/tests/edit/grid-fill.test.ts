import { MeshEditError, gridFill } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { openCube, topHoleLoop } from "./fixtures/connectivity.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const euler = (em: ReturnType<typeof openCube>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("gridFill", () => {
  test("fills an even boundary with deterministic triangles and closes the manifold", () => {
    const em = openCube(), boundary = topHoleLoop(em), result = gridFill(em, boundary);
    expect(result.mesh.faceCount).toBe(em.faceCount + boundary.count);
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(result.warnings?.map((w) => w.code)).toContain("GRID_FILL_TRIANGULATED");
  });

  test("returns all inserted grid-fill triangles", () => {
    const em = openCube(), result = gridFill(em, topHoleLoop(em));
    expect(result.newFaces.domain).toBe("face");
    expect(result.newFaces.indices).toEqual([em.faceCount, em.faceCount + 1, em.faceCount + 2, em.faceCount + 3]);
  });

  test("preserves boundary sharp edges and makes new faces smooth", () => {
    const em = openCube(), boundary = topHoleLoop(em); for (const e of boundary.indices) unwrapKernel(em.gpu.halfEdgeKernel).isSharp[e] = 1;
    const result = gridFill(em, boundary), k = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.newFaces.indices.every((f) => k.useSmooth[f] === 1)).toBe(true);
    expect(result.mesh.hardEdges.count).toBeGreaterThanOrEqual(boundary.count);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = openCube(), none = em.edges.none();
    expect(() => gridFill(em, none)).toThrow(MeshEditError);
    try { gridFill(em, none); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("invalid explicit span throws and valid span is reported", () => {
    const em = openCube();
    expect(() => gridFill(em, topHoleLoop(em), { spanMode: 0 })).toThrow(MeshEditError);
    const result = gridFill(em, topHoleLoop(em), { spanMode: 2 });
    expect(result.warnings?.[0]?.reason).toContain("2 span");
  });

  test("is deterministic for repeated inputs", () => {
    const em = openCube(), sel = topHoleLoop(em), a = gridFill(em, sel), b = gridFill(em, sel);
    expect(a.warnings).toEqual(b.warnings);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });
});
