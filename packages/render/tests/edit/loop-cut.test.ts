import { EditableMesh, MeshEditError, loopCut } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { editableSignature } from "./_helpers.ts";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
const tetra = () => tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const cube = () => tri([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5], [1, 2, 6, 1, 6, 5, 4, 7, 3, 4, 3, 0, 3, 7, 6, 3, 6, 2, 4, 0, 1, 4, 1, 5, 4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2]);
const cylinder = (n = 8) => { const pos: number[] = [], idx: number[] = []; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a); pos.push(x, -1, z, x, 1, z); } for (let i = 0; i < n; i++) { const j = (i + 1) % n, a = i * 2, b = j * 2, c = j * 2 + 1, d = i * 2 + 1; idx.push(a, b, c, a, c, d); } return tri(pos, idx); };
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

  test("creates a closed midpoint ring on a cube", () => {
    const em = cube(), seed = verticalEdges(em)[0], result = loopCut(em, seed), k = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.warnings).toBeUndefined();
    expect(result.mesh.vertexCount).toBe(12);
    expect(result.mesh.faceCount).toBe(20);
    expect(result.insertedLoop.count).toBe(4);
    const degree = new Map<number, number>();
    for (const e of result.insertedLoop.indices) { degree.set(k.edgeVertexA[e], (degree.get(k.edgeVertexA[e]) ?? 0) + 1); degree.set(k.edgeVertexB[e], (degree.get(k.edgeVertexB[e]) ?? 0) + 1); }
    expect([...degree.values()]).toEqual([2, 2, 2, 2]);
  });

  test("creates one loop segment per cylinder side", () => {
    const em = cylinder(8), result = loopCut(em, verticalEdges(em)[0]);
    expect(result.warnings).toBeUndefined();
    expect(result.insertedLoop.count).toBe(8);
  });

  test("boundary seed edge falls back with ambiguous-continuation warning", () => {
    const em = tri([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]), result = loopCut(em, 0);
    expect(result.warnings?.[0]?.code).toBe("LOOP_CUT_AMBIGUOUS_CONTINUATION");
    expect(result.insertedLoop.count).toBe(2);
  });

  test("markSharp true marks inserted ring edges only", () => {
    const em = cube(); unwrapKernel(em.gpu.halfEdgeKernel).isSharp.fill(0); unwrapKernel(em.gpu.halfEdgeKernel).isSharp[verticalEdges(em)[1]] = 1;
    const result = loopCut(em, verticalEdges(em)[0], { markSharp: true }), k = unwrapKernel(result.mesh.gpu.halfEdgeKernel);
    expect(result.insertedLoop.indices.every((e) => k.isSharp[e] === 1)).toBe(true);
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

function verticalEdges(em: ReturnType<typeof tetra>): number[] {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), out: number[] = [];
  for (let e = 0; e < em.edgeCount; e++) if (Math.abs(k.positions[k.edgeVertexA[e] * 3 + 1] - k.positions[k.edgeVertexB[e] * 3 + 1]) > 0.9) out.push(e);
  return out;
}
