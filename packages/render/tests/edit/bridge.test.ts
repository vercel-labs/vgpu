import { MeshEditError, bridge } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { plateLoops, twoPlates } from "./fixtures/connectivity.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./helpers.ts";

const euler = (em: ReturnType<typeof twoPlates>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("bridge", () => {
  test("bridges two ordered loops and preserves closed-manifold Euler characteristic", () => {
    const em = twoPlates(), result = bridge(em, plateLoops(em));
    expect(result.mesh.faceCount).toBe(em.faceCount + 8);
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
  });

  test("returns bridge face descendants and chosen twist", () => {
    const em = twoPlates(), result = bridge(em, plateLoops(em));
    expect(result.bridgeFaces.domain).toBe("face");
    expect(result.bridgeFaces.indices).toEqual([em.faceCount, em.faceCount + 1, em.faceCount + 2, em.faceCount + 3, em.faceCount + 4, em.faceCount + 5, em.faceCount + 6, em.faceCount + 7]);
    expect(result.chosenTwist).toBe(0);
  });

  test("keeps bridge edges smooth and new faces smooth", () => {
    const em = twoPlates(), sel = plateLoops(em); for (const e of sel.indices) unwrapKernel(em.gpu.halfEdgeKernel).isSharp[e] = 1;
    const result = bridge(em, sel), k = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.bridgeFaces.indices.every((f) => k.useSmooth[f] === 1)).toBe(true);
    expect(result.bridgeFaces.indices.some((f) => k.faceEdges.slice(f * 3, f * 3 + 3).some((e) => k.isSharp[e] === 0))).toBe(true);
  });

  test("empty selection throws EMPTY_SELECTION", () => {
    const em = twoPlates(), none = em.edges.none();
    expect(() => bridge(em, none)).toThrow(MeshEditError);
    try { bridge(em, none); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("unsupported merge mode throws explicitly", () => {
    const em = twoPlates();
    expect(() => bridge(em, plateLoops(em), { mode: "merge" })).toThrow(MeshEditError);
    try { bridge(em, plateLoops(em), { mode: "merge" }); } catch (error) { expect((error as MeshEditError).code).toBe("UNSUPPORTED_INPUT"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = twoPlates(), sel = plateLoops(em), a = bridge(em, sel), b = bridge(em, sel);
    expect(a.chosenTwist).toBe(b.chosenTwist);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });
});
