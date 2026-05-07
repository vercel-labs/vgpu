import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import { EditableMesh, MeshEditWarning, toEditable, toEditableWithDiagnostics } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";

const tri = (positions: number[], indices: number[]) => EditableMesh.fromArrays({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });

function euler(em: ReturnType<typeof EditableMesh.fromArrays>) {
  return em.vertexCount - em.edgeCount + em.faceCount;
}

describe("editable mesh foundation", () => {
  test("half-edge kernel satisfies Euler formula on closed fixtures", () => {
    const tetra = tri([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const box = EditableMesh.fromArrays({ positions: new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]), indices: new Uint32Array([1, 2, 6, 1, 6, 5, 4, 7, 3, 4, 3, 0, 3, 7, 6, 3, 6, 2, 4, 0, 1, 4, 1, 5, 4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2]) });
    const cone = tri([0, 1, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1, 0, -1, 0], [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 2, 1, 5, 3, 2, 5, 4, 3, 5, 1, 4]);
    expect([tetra, box, cone].map(euler)).toEqual([2, 2, 2]);
  });

  test("manifold checks distinguish open meshes", () => {
    expect(tri([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]).isManifold).toBe(false);
  });

  test("Mesh.box bridge round-trips byte-equal and preserves hard edges", async () => {
    const { device } = await App.create({ adapter: createMockAdapter() });
    const box = Mesh.box({ device });
    const em = toEditable(box);
    expect(em.edgeCount).toBe(18);
    expect(em.hardEdges.count).toBe(12);
    expect(Array.from(em.gpu.halfEdgeKernel.useSmooth)).toEqual(new Array(12).fill(1));
    const baked = em.toRenderMesh({ device });
    expect(new Uint8Array(await baked.vertexBuffer.read(baked.vertexBuffer.options.size))).toEqual(new Uint8Array(await box.vertexBuffer.read(box.vertexBuffer.options.size)));
    const again = toEditable(baked);
    expect(again.hardEdges.indices).toEqual(em.hardEdges.indices);
    expect(Array.from(again.gpu.halfEdgeKernel.useSmooth)).toEqual(Array.from(em.gpu.halfEdgeKernel.useSmooth));
    device.destroy();
  });

  test("selection composition covers sets, walks, and scored tie-breaks", () => {
    const em = tri([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
    expect(em.faces.all().indices).toEqual([0, 1]);
    expect(em.faces.none().count).toBe(0);
    expect(em.vertices.where((v) => v.position[0] === 1).indices).toEqual([1, 2]);
    expect(em.faces.scoreBy(() => 1).top().indices).toEqual([0]);
    expect(em.faces.scoreBy(() => 1).topN(2).indices).toEqual([0, 1]);
    expect(em.faces.scoreBy((f) => f.center[0]).bottom().indices).toEqual([1]);
    expect(em.faces.scoreBy((f) => f.center[0]).threshold(0.5).indices).toEqual([0]);
    const one = em.faces.byIndex([0]);
    expect(em.faces.grow(one).indices).toEqual([0, 1]);
    expect(em.faces.shrink(em.faces.all()).indices).toEqual([0, 1]);
    expect(em.faces.boundaryOf(one).domain).toBe("edge");
    expect(em.edges.loop(0).ordered).toBe(true);
    expect(em.edges.ring(0).count).toBeGreaterThan(0);
    expect(em.faces.connectedComponentOf(0).indices).toEqual([0, 1]);
  });

  test("render meshes baked from arrays carry edit source for round-trip", async () => {
    const { device } = await App.create({ adapter: createMockAdapter() });
    const em = tri([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const again = toEditable(em.toRenderMesh({ device }));
    expect(again.vertexCount).toBe(3);
    expect(again.faceCount).toBe(1);
    expect(Array.from(again.gpu.halfEdgeKernel.faceVertices)).toEqual([0, 1, 2]);
    device.destroy();
  });

  test("diagnostic bridge emits tangent strip warning", async () => {
    const { device } = await App.create({ adapter: createMockAdapter() });
    const mesh = { ...Mesh.box({ device }), attributes: { ...Mesh.box({ device }).attributes, tangent: { offset: 24, format: "float32x4" } } } as never;
    const result = toEditableWithDiagnostics(mesh);
    expect(result.warnings[0]).toBeInstanceOf(MeshEditWarning);
    expect(result.warnings[0].code).toBe("TANGENTS_STRIPPED");
    device.destroy();
  });
});
