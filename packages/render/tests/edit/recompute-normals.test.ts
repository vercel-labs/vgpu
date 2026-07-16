import { recomputeNormals } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { bentSmoothPair, emptyMesh } from "./fixtures/cleanup.ts";
import type { EditableMeshValue } from "@vgpu/render/edit";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./helpers.ts";

const n = (em: EditableMeshValue, f: number) => Array.from(unwrapKernel(em.gpu.halfEdgeKernel).faceNormals.slice(f * 3, f * 3 + 3));
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const weightingFixture = () => bentSmoothPair();

describe("recomputeNormals", () => {
  test("writes unit-length normals", () => {
    const result = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI });
    for (let f = 0; f < result.faceCount; f++) expect(len(n(result, f))).toBeCloseTo(1, 6);
  });

  test("default preserves existing sharp flags", () => {
    const em = bentSmoothPair(), k = unwrapKernel(em.gpu.halfEdgeKernel); k.isSharp.fill(0); k.isSharp[0] = 1;
    const result = recomputeNormals(em);
    expect(Array.from(unwrapKernel(result.gpu.halfEdgeKernel).isSharp)).toEqual(Array.from(k.isSharp));
  });

  test("explicit crease angle re-detects sharp flags", () => {
    const em = bentSmoothPair(); unwrapKernel(em.gpu.halfEdgeKernel).isSharp.fill(0);
    const result = recomputeNormals(em, { creaseAngle: 0.1 });
    expect(Array.from(unwrapKernel(result.gpu.halfEdgeKernel).isSharp).some(Boolean)).toBe(true);
  });

  test("sharp creases keep per-face normals", () => {
    const result = recomputeNormals(bentSmoothPair(), { creaseAngle: 0.1 });
    expect(dot(n(result, 0), n(result, 1))).toBeLessThan(0.99);
  });

  test("smooth regions share recomputed normals", () => {
    const result = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI });
    expect(n(result, 0)).toEqual(n(result, 1));
  });

  test("angle weighting differs from area weighting on asymmetric smooth regions", () => {
    const angle = recomputeNormals(weightingFixture(), { weighting: "angle", creaseAngle: Math.PI });
    const area = recomputeNormals(weightingFixture(), { weighting: "area", creaseAngle: Math.PI });
    expect(dot(n(angle, 0), n(area, 0))).toBeLessThan(0.999);
  });

  test("empty meshes no-op gracefully", () => {
    const em = emptyMesh(), result = recomputeNormals(em);
    expect(result).toBe(em); expect(result.faceCount).toBe(0);
  });

  test("is deterministic", () => {
    const a = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI }), b = recomputeNormals(bentSmoothPair(), { creaseAngle: Math.PI });
    expect(editableSignature(a)).toEqual(editableSignature(b));
  });
});
