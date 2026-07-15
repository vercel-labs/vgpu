import { MeshEditError, dissolveEdges } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { openCube, topHoleLoop } from "./fixtures/connectivity.ts";
import { octahedron } from "./fixtures/dissolve.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./helpers.ts";

const euler = (em: ReturnType<typeof octahedron>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("dissolveEdges", () => {
  test("dissolves an interior edge by replacing it with the opposite diagonal", () => {
    const em = octahedron(), edge = edgeBetween(em, 0, 1), result = dissolveEdges(em, em.edges.byIndex([edge]));
    expect(result.mesh.faceCount).toBe(em.faceCount);
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(hasCoordEdge(result.mesh, em, 0, 1)).toBe(false);
    expect(hasCoordEdge(result.mesh, em, 2, 4)).toBe(true);
  });

  test("returns merged face descendants", () => {
    const em = octahedron(), result = dissolveEdges(em, em.edges.byIndex([edgeBetween(em, 0, 1)]));
    expect(result.mergedFaces.domain).toBe("face");
    expect(result.mergedFaces.indices).toEqual([6, 7]);
  });

  test("ORs dissolved sharp state onto the merged neighborhood", () => {
    const em = octahedron(), k = unwrapKernel(em.gpu.halfEdgeKernel), edge = edgeBetween(em, 0, 1);
    k.useSmooth[k.edgeFaceA[edge]] = 0; k.useSmooth[k.edgeFaceB[edge]] = 1;
    k.isSharp.fill(0); k.isSharp[edge] = 1; k.isSharp[edgeBetween(em, 1, 2)] = 0; k.isSharp[edgeBetween(em, 0, 4)] = 1;
    const fa = k.edgeFaceA[edge], fb = k.edgeFaceB[edge], c = other(k.faceVertices.slice(fa * 3, fa * 3 + 3), 0, 1), d = other(k.faceVertices.slice(fb * 3, fb * 3 + 3), 0, 1);
    const result = dissolveEdges(em, em.edges.byIndex([edge])), out = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.mergedFaces.indices.every((f) => out.useSmooth[f] === 1)).toBe(true);
    expect(sharpCoordEdge(result.mesh, em, c, 0)).toBe(true);
    expect(sharpCoordEdge(result.mesh, em, 0, d)).toBe(true);
    expect(sharpCoordEdge(result.mesh, em, d, 1)).toBe(true);
    expect(sharpCoordEdge(result.mesh, em, 1, c)).toBe(true);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = octahedron();
    expect(() => dissolveEdges(em, em.edges.none())).toThrow(MeshEditError);
    try { dissolveEdges(em, em.edges.none()); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = octahedron(), sel = em.edges.byIndex([edgeBetween(em, 0, 1)]), a = dissolveEdges(em, sel), b = dissolveEdges(em, sel);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });

  test("warns and preserves topology for a boundary edge", () => {
    const em = openCube(), result = dissolveEdges(em, em.edges.byIndex([topHoleLoop(em).indices[0]]));
    expect(result.warnings?.map((w) => w.code)).toContain("NON_MANIFOLD_EDGE_SKIPPED");
    expect(result.mesh.faceCount).toBe(em.faceCount);
    expect(result.mergedFaces.count).toBe(0);
  });
});

function other(vs: ArrayLike<number>, a: number, b: number): number { for (let i = 0; i < vs.length; i++) if (vs[i] !== a && vs[i] !== b) return vs[i]; return a; }
function edgeBetween(em: ReturnType<typeof octahedron>, a: number, b: number): number {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), lo = Math.min(a, b), hi = Math.max(a, b);
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === lo && k.edgeVertexB[e] === hi) return e;
  throw new Error("missing edge");
}
function hasCoordEdge(em: ReturnType<typeof octahedron>, source: ReturnType<typeof octahedron>, a: number, b: number): boolean {
  return coordEdge(em, source, a, b) >= 0;
}
function sharpCoordEdge(em: ReturnType<typeof octahedron>, source: ReturnType<typeof octahedron>, a: number, b: number): boolean {
  const edge = coordEdge(em, source, a, b); return edge >= 0 && unwrapKernel(em.gpu.halfEdgeKernel).isSharp[edge] === 1;
}
function coordEdge(em: ReturnType<typeof octahedron>, source: ReturnType<typeof octahedron>, a: number, b: number): number {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), sa = coord(source, a), sb = coord(source, b);
  for (let e = 0; e < k.edgeCount; e++) if ((same(coord(em, k.edgeVertexA[e]), sa) && same(coord(em, k.edgeVertexB[e]), sb)) || (same(coord(em, k.edgeVertexA[e]), sb) && same(coord(em, k.edgeVertexB[e]), sa))) return e;
  return -1;
}
function coord(em: ReturnType<typeof octahedron>, v: number): readonly number[] { const p = unwrapKernel(em.gpu.halfEdgeKernel).positions, i = v * 3; return [p[i], p[i + 1], p[i + 2]]; }
function same(a: readonly number[], b: readonly number[]): boolean { return a.every((v, i) => v === b[i]); }
