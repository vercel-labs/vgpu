import { MeshEditError, dissolveEdges } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { openCube, topHoleLoop } from "./fixtures/connectivity.ts";
import { octahedron } from "./fixtures/dissolve.ts";

const euler = (em: ReturnType<typeof octahedron>) => em.vertexCount - em.edgeCount + em.faceCount;
const signature = (em: ReturnType<typeof octahedron>) => [em.vertexCount, em.edgeCount, em.faceCount, ...Array.from(em.gpu.halfEdgeKernel.positions), ...Array.from(em.gpu.halfEdgeKernel.faceVertices), ...Array.from(em.gpu.halfEdgeKernel.isSharp)];

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
    expect(result.descendants.mergedFaces.domain).toBe("face");
    expect(result.descendants.mergedFaces.indices).toEqual([6, 7]);
  });

  test("keeps surviving sharp edges and ORs smoothing onto merged faces", () => {
    const em = octahedron(), k = em.gpu.halfEdgeKernel, edge = edgeBetween(em, 0, 1);
    k.useSmooth[k.edgeFaceA[edge]] = 0; k.useSmooth[k.edgeFaceB[edge]] = 1; k.isSharp[edgeBetween(em, 1, 2)] = 1;
    const result = dissolveEdges(em, em.edges.byIndex([edge])), out = result.mesh.gpu.halfEdgeKernel;
    expect(result.descendants.mergedFaces.indices.every((f) => out.useSmooth[f] === 1)).toBe(true);
    expect(result.mesh.hardEdges.count).toBeGreaterThan(0);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = octahedron();
    expect(() => dissolveEdges(em, em.edges.none())).toThrow(MeshEditError);
    try { dissolveEdges(em, em.edges.none()); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = octahedron(), sel = em.edges.byIndex([edgeBetween(em, 0, 1)]), a = dissolveEdges(em, sel), b = dissolveEdges(em, sel);
    expect(a.descendants).toEqual(b.descendants);
    expect(signature(a.mesh)).toEqual(signature(b.mesh));
  });

  test("warns and preserves topology for a boundary edge", () => {
    const em = openCube(), result = dissolveEdges(em, em.edges.byIndex([topHoleLoop(em).indices[0]]));
    expect(result.warnings?.map((w) => w.code)).toContain("NON_MANIFOLD_EDGE_SKIPPED");
    expect(result.mesh.faceCount).toBe(em.faceCount);
    expect(result.descendants.mergedFaces.count).toBe(0);
  });
});

function edgeBetween(em: ReturnType<typeof octahedron>, a: number, b: number): number {
  const k = em.gpu.halfEdgeKernel, lo = Math.min(a, b), hi = Math.max(a, b);
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === lo && k.edgeVertexB[e] === hi) return e;
  throw new Error("missing edge");
}
function hasCoordEdge(em: ReturnType<typeof octahedron>, source: ReturnType<typeof octahedron>, a: number, b: number): boolean {
  const k = em.gpu.halfEdgeKernel, sa = coord(source, a), sb = coord(source, b);
  for (let e = 0; e < k.edgeCount; e++) if ((same(coord(em, k.edgeVertexA[e]), sa) && same(coord(em, k.edgeVertexB[e]), sb)) || (same(coord(em, k.edgeVertexA[e]), sb) && same(coord(em, k.edgeVertexB[e]), sa))) return true;
  return false;
}
function coord(em: ReturnType<typeof octahedron>, v: number): readonly number[] { const p = em.gpu.halfEdgeKernel.positions, i = v * 3; return [p[i], p[i + 1], p[i + 2]]; }
function same(a: readonly number[], b: readonly number[]): boolean { return a.every((v, i) => v === b[i]); }
