import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import { bevel, extrude, inset, toEditable, type EditableMeshValue, type ElementSelection } from "@vgpu/render/edit";
import { expect, test } from "vitest";
import { ANGLES, expectEditSnapshot, highlightMesh, renderEditMesh, sha } from "./_helpers.ts";

interface Case { readonly name: "extrude" | "bevel" | "inset"; readonly before: EditableMeshValue; readonly after: EditableMeshValue; readonly highlight: ElementSelection }

const makeCases = (base: EditableMeshValue): readonly Case[] => {
  const top = base.faces.scoreBy((f) => f.center[1]).top();
  const e = extrude(base, top, { distance: 0.35 });
  const b = bevel(base, base.hardEdges, { offset: 0.08 });
  const i = inset(base, top, { thickness: 0.22, depth: 0.04 });
  return [
    { name: "extrude", before: base, after: e.mesh, highlight: e.descendants.capFaces },
    { name: "bevel", before: base, after: b.mesh, highlight: b.descendants.newFaces },
    { name: "inset", before: base, after: i.mesh, highlight: i.descendants.insetFaces },
  ];
};

for (const op of ["extrude", "bevel", "inset"] as const) {
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
