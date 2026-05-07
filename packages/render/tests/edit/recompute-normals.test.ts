import { recomputeNormals } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { bentSmoothPair, emptyMesh } from "./fixtures/cleanup.ts";
import type { EditableMeshValue } from "@vgpu/render/edit";

const n = (em: EditableMeshValue, f: number) => Array.from(em.gpu.halfEdgeKernel.faceNormals.slice(f * 3, f * 3 + 3));
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const signature = (em: EditableMeshValue) => [em.vertexCount, em.edgeCount, em.faceCount, ...Array.from(em.gpu.halfEdgeKernel.faceNormals), ...Array.from(em.gpu.halfEdgeKernel.isSharp)];
const weightingFixture = () => bentSmoothPair();

describe("recomputeNormals", () => {
  test("writes unit-length normals", () => {
    const result = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI });
    for (let f = 0; f < result.mesh.faceCount; f++) expect(len(n(result.mesh, f))).toBeCloseTo(1, 6);
  });

  test("sharp creases keep per-face normals", () => {
    const result = recomputeNormals(bentSmoothPair(), { creaseAngle: 0.1 });
    expect(dot(n(result.mesh, 0), n(result.mesh, 1))).toBeLessThan(0.99);
  });

  test("smooth regions share recomputed normals", () => {
    const result = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI });
    expect(n(result.mesh, 0)).toEqual(n(result.mesh, 1));
  });

  test("angle weighting differs from area weighting on asymmetric smooth regions", () => {
    const angle = recomputeNormals(weightingFixture(), { weighting: "angle", creaseAngle: Math.PI });
    const area = recomputeNormals(weightingFixture(), { weighting: "area", creaseAngle: Math.PI });
    expect(dot(n(angle.mesh, 0), n(area.mesh, 0))).toBeLessThan(0.999);
  });

  test("empty meshes no-op gracefully", () => {
    const em = emptyMesh(), result = recomputeNormals(em);
    expect(result.mesh).toBe(em);
    expect(result.mesh.faceCount).toBe(0);
  });

  test("is deterministic", () => {
    const a = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI }), b = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI });
    expect(signature(a.mesh)).toEqual(signature(b.mesh));
  });
});
