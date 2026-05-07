import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import { bevel, extrude, inset, loopCut, subdivideEdges, subdivideFaces, toEditable, type EditableMeshValue, type ElementSelection } from "@vgpu/render/edit";
import { expect, test } from "vitest";
import { ANGLES, expectEditSnapshot, highlightMesh, renderEditMesh, sha } from "./_helpers.ts";

interface Case { readonly name: "extrude" | "bevel" | "inset" | "subdivide-edges" | "subdivide-faces" | "loop-cut"; readonly before: EditableMeshValue; readonly after: EditableMeshValue; readonly highlight: ElementSelection }

const makeCases = (base: EditableMeshValue): readonly Case[] => {
  const top = base.faces.scoreBy((f) => f.center[1]).top();
  const e = extrude(base, top, { distance: 0.35 });
  const b = bevel(base, base.hardEdges, { offset: 0.08 });
  const i = inset(base, top, { thickness: 0.22, depth: 0.04 });
  const se = subdivideEdges(base, base.edges.all());
  const sf = subdivideFaces(base, base.faces.all());
  const lc = loopCut(base, base.edges.scoreBy((edge) => Math.abs(edge.direction[1])).top().indices[0]);
  return [
    { name: "extrude", before: base, after: e.mesh, highlight: e.descendants.capFaces },
    { name: "bevel", before: base, after: b.mesh, highlight: b.descendants.newFaces },
    { name: "inset", before: base, after: i.mesh, highlight: i.descendants.insetFaces },
    { name: "subdivide-edges", before: base, after: se.mesh, highlight: se.descendants.newEdges },
    { name: "subdivide-faces", before: base, after: sf.mesh, highlight: sf.descendants.newFaces },
    { name: "loop-cut", before: base, after: lc.mesh, highlight: lc.descendants.insertedLoop },
  ];
};

for (const op of ["extrude", "bevel", "inset", "subdivide-edges", "subdivide-faces", "loop-cut"] as const) {
  test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")(`${op} snapshot battery`, async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    try {
      const c = makeCases(toEditable(Mesh.box({ device, size: 1 }))).find((v) => v.name === op)!;
      const before = new Map<string, Uint8Array>(), after = new Map<string, Uint8Array>();
      for (const angle of Object.keys(ANGLES) as (keyof typeof ANGLES)[]) {
        const b = await renderEditMesh(device, c.before.toRenderMesh({ device }), angle), a = await renderEditMesh(device, c.after.toRenderMesh({ device }), angle);
        before.set(angle, b); after.set(angle, a);
        await expectEditSnapshot(`${op}-before-${angle}.png`, b);
        await expectEditSnapshot(`${op}-after-${angle}.png`, a);
        expect(sha(b)).not.toBe(sha(a));
      }
      const hi = await renderEditMesh(device, highlightMesh(device, c.after, c.highlight), "iso");
      await expectEditSnapshot(`${op}-after-highlight-iso.png`, hi);
      expect(sha(hi)).not.toBe(sha(after.get("iso")!));
      for (const set of [before, after]) {
        const hashes = [...set.values()].map(sha);
        expect(new Set(hashes).size).toBe(hashes.length);
      }
    } finally { device.destroy(); }
  });
}
