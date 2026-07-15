import { MeshEditError, dissolveVertices } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { octahedron, tJunctionVertex } from "./fixtures/dissolve.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./helpers.ts";

const euler = (em: ReturnType<typeof octahedron>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("dissolveVertices", () => {
  test("dissolves an interior vertex into surrounding triangulated faces", () => {
    const em = octahedron(), result = dissolveVertices(em, em.vertices.byIndex([0]));
    expect(result.mesh.vertexCount).toBe(5);
    expect(result.mesh.faceCount).toBe(6);
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
  });

  test("returns surrounding face descendants", () => {
    const em = octahedron(), result = dissolveVertices(em, em.vertices.byIndex([0]));
    expect(result.surroundingFaces.domain).toBe("face");
    expect(result.surroundingFaces.indices).toEqual([4, 5]);
  });

  test("propagates survivor face smoothing with OR and preserves remaining sharp edges", () => {
    const em = octahedron(), k = unwrapKernel(em.gpu.halfEdgeKernel);
    k.useSmooth[0] = 0; k.useSmooth[1] = 1; k.isSharp[edgeBetween(em, 1, 2)] = 1;
    const result = dissolveVertices(em, em.vertices.byIndex([0])), out = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.surroundingFaces.indices.every((f) => out.useSmooth[f] === 1)).toBe(true);
    expect(result.mesh.hardEdges.count).toBeGreaterThan(0);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = octahedron();
    expect(() => dissolveVertices(em, em.vertices.none())).toThrow(MeshEditError);
    try { dissolveVertices(em, em.vertices.none()); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = octahedron(), sel = em.vertices.byIndex([0]), a = dissolveVertices(em, sel), b = dissolveVertices(em, sel);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });

  test("warns and skips a T-junction boundary vertex", () => {
    const em = tJunctionVertex(), result = dissolveVertices(em, em.vertices.byIndex([0]));
    expect(result.warnings?.map((w) => w.code)).toContain("NON_MANIFOLD_VERTEX_SKIPPED");
    expect(result.surroundingFaces.count).toBe(0);
  });
});

function edgeBetween(em: ReturnType<typeof octahedron>, a: number, b: number): number {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), lo = Math.min(a, b), hi = Math.max(a, b);
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === lo && k.edgeVertexB[e] === hi) return e;
  throw new Error("missing edge");
}
