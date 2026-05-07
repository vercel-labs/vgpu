import { EditableMesh, MeshEditError, loopCut } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const euler = (em: ReturnType<typeof tetra>) => em.vertexCount - em.edgeCount + em.faceCount;

describe("loopCut", () => {
  test("cuts from a seed edge and preserves manifold Euler characteristic", () => {
    const em = tetra(), result = loopCut(em, 0, { cuts: 1 });
    expect(euler(result.mesh)).toBe(2);
    expect(result.mesh.isManifold).toBe(true);
    expect(result.mesh.edgeCount).toBeGreaterThan(em.edgeCount);
  });

  test("returns an ordered inserted loop descendant selection", () => {
    const result = loopCut(tetra(), 0, { cuts: 1 });
    expect(result.insertedLoop.domain).toBe("edge");
    expect(result.insertedLoop.ordered).toBe(true);
    expect(result.insertedLoop.count).toBeGreaterThan(0);
  });

  test("new inserted-loop edges default smooth", () => {
    const em = tetra(); unwrapKernel(em.gpu.halfEdgeKernel).isSharp.fill(0); unwrapKernel(em.gpu.halfEdgeKernel).isSharp[0] = 1;
    const result = loopCut(em, 0, { cuts: 1 });
    expect(result.insertedLoop.indices.every((e) => unwrapKernel(result.mesh.gpu.halfEdgeKernel).isSharp[e] === 0)).toBe(true);
  });

  test("invalid seed throws EMPTY_SELECTION", () => {
    const em = tetra();
    expect(() => loopCut(em, -1)).toThrow(MeshEditError);
    try { loopCut(em, -1); } catch (error) { expect((error as MeshEditError).code).toBe("EMPTY_SELECTION"); }
  });

  test("is deterministic for repeated inputs", () => {
    const em = tetra(), a = loopCut(em, 0), b = loopCut(em, 0);
    expect(editableSignature(a.mesh)).toEqual(editableSignature(b.mesh));
  });
});
