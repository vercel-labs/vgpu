import { MeshEditError, dissolveFaces } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { octahedron } from "./fixtures/dissolve.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./helpers.ts";

const euler = (em: ReturnType<typeof octahedron>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("dissolveFaces", () => {
  test("dissolves connected faces and retriangulates the result deterministically", () => {
    const em = octahedron(), result = dissolveFaces(em, em.faces.byIndex([0, 1]));
    expect(result.mesh.faceCount).toBe(em.faceCount);
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(result.warnings?.map((w) => w.code)).toContain("DISSOLVE_FACES_RETRIANGULATED");
  });

  test("returns result face descendants", () => {
    const em = octahedron(), result = dissolveFaces(em, em.faces.byIndex([0, 1]));
    expect(result.resultFace.domain).toBe("face");
    expect(result.resultFace.indices).toEqual([6, 7]);
  });

  test("keeps surviving sharp edges and ORs smoothing onto result faces", () => {
    const em = octahedron(), k = unwrapKernel(em.gpu.halfEdgeKernel);
    k.useSmooth[0] = 0; k.useSmooth[1] = 1; k.isSharp[edgeBetween(em, 1, 2)] = 1;
    const result = dissolveFaces(em, em.faces.byIndex([0, 1])), out = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.resultFace.indices.every((f) => out.useSmooth[f] === 1)).toBe(true);
    expect(result.mesh.hardEdges.count).toBeGreaterThan(0);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = octahedron();
    expect(() => dissolveFaces(em, em.faces.none())).toThrow(MeshEditError);
    try { dissolveFaces(em, em.faces.none()); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = octahedron(), sel = em.faces.byIndex([0, 1]), a = dissolveFaces(em, sel), b = dissolveFaces(em, sel);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });

  test("handles disconnected selected components deterministically", () => {
    const em = octahedron(), result = dissolveFaces(em, em.faces.byIndex([0, 5]));
    expect(result.resultFace.count).toBe(2);
    expect(result.mesh.faceCount).toBe(em.faceCount);
  });
});

function edgeBetween(em: ReturnType<typeof octahedron>, a: number, b: number): number {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), lo = Math.min(a, b), hi = Math.max(a, b);
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === lo && k.edgeVertexB[e] === hi) return e;
  throw new Error("missing edge");
}
