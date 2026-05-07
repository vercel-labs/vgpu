import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import { bevel, bridge, dissolveEdges, dissolveFaces, dissolveVertices, extrude, fillHole, gridFill, healManifold, inset, loopCut, mergeByDistance, recomputeNormals, subdivideEdges, subdivideFaces, toEditable, type EditableMeshValue, type ElementSelection } from "@vgpu/render/edit";
import { expect, test } from "vitest";
import { ANGLES, expectEditSnapshot, highlightMesh, renderEditMesh, sha } from "./_helpers.ts";
import { openCube, plateLoops, topHoleLoop, twoPlates } from "./fixtures/connectivity.ts";
import { octahedron } from "./fixtures/dissolve.ts";
import { bentSmoothPair, mergeDuplicateTetra, nonManifoldTetra } from "./fixtures/cleanup.ts";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";

interface Case { readonly name: "extrude" | "bevel" | "inset" | "subdivide-edges" | "subdivide-faces" | "loop-cut" | "bridge" | "fill-hole" | "grid-fill" | "dissolve-vertices" | "dissolve-edges" | "dissolve-faces" | "merge-by-distance" | "heal-manifold" | "recompute-normals"; readonly before: EditableMeshValue; readonly after: EditableMeshValue; readonly highlight?: ElementSelection; readonly highlightOn?: "before" | "after" }

const makeCases = (base: EditableMeshValue): readonly Case[] => {
  const top = base.faces.scoreBy((f) => f.center[1]).top();
  const e = extrude(base, top, { distance: 0.35 });
  const b = bevel(base, base.hardEdges, { offset: 0.08 });
  const i = inset(base, top, { thickness: 0.22, depth: 0.04 });
  const se = subdivideEdges(base, base.edges.all());
  const sf = subdivideFaces(base, base.faces.all());
  const lc = loopCut(base, base.edges.scoreBy((edge) => Math.abs(edge.direction[1])).top().indices[0]);
  return [
    { name: "extrude", before: base, after: e.mesh, highlight: e.capFaces },
    { name: "bevel", before: base, after: b.mesh, highlight: b.newFaces },
    { name: "inset", before: base, after: i.mesh, highlight: i.insetFaces },
    { name: "subdivide-edges", before: base, after: se.mesh, highlight: se.newEdges },
    { name: "subdivide-faces", before: base, after: sf.mesh, highlight: sf.newFaces },
    { name: "loop-cut", before: base, after: lc.mesh, highlight: lc.insertedLoop },
  ];
};

const makeConnectivityCases = (): readonly Case[] => {
  const hole = openCube(), plates = twoPlates();
  const br = bridge(plates, plateLoops(plates)), fh = fillHole(hole, topHoleLoop(hole)), gf = gridFill(hole, topHoleLoop(hole));
  return [
    { name: "bridge", before: plates, after: br.mesh, highlight: br.bridgeFaces },
    { name: "fill-hole", before: hole, after: fh.mesh, highlight: fh.newFaces },
    { name: "grid-fill", before: hole, after: gf.mesh, highlight: gf.newFaces },
  ];
};

const makeDissolveCases = (): readonly Case[] => {
  const vBase = octahedron(), vSel = vBase.vertices.byIndex([0]), v = dissolveVertices(vBase, vSel);
  const eBase = octahedron(), eSel = eBase.edges.byIndex([edgeBetween(eBase, 0, 1)]), e = dissolveEdges(eBase, eSel);
  const fBase = octahedron(), fSel = fBase.faces.byIndex([0, 1]), f = dissolveFaces(fBase, fSel);
  return [
    { name: "dissolve-vertices", before: vBase, after: v.mesh, highlight: vSel, highlightOn: "before" },
    { name: "dissolve-edges", before: eBase, after: e.mesh, highlight: eSel, highlightOn: "before" },
    { name: "dissolve-faces", before: fBase, after: f.mesh, highlight: fSel, highlightOn: "before" },
  ];
};

const makeCleanupCases = (): readonly Case[] => {
  const mBase = mergeDuplicateTetra(), mSel = mBase.vertices.byIndex([0, 4]), m = mergeByDistance(mBase, { selection: mSel, threshold: 0.3 });
  const hBase = nonManifoldTetra(), h = healManifold(hBase), hSel = hBase.faces.byIndex([4]);
  tintFirstFace(m.mesh); tintFirstFace(h.mesh);
  const rBase = bentSmoothPair(); unwrapKernel(rBase.gpu.halfEdgeKernel).faceNormals.set([1, 0, 0], 0); const r = recomputeNormals(rBase, { creaseAngle: Math.PI });
  return [
    { name: "merge-by-distance", before: mBase, after: m.mesh, highlight: mSel, highlightOn: "before" },
    { name: "heal-manifold", before: hBase, after: h.mesh, highlight: hSel, highlightOn: "before" },
    // recomputeNormals is a pure-attribute op with no descendants; this battery intentionally omits a highlight snapshot.
    { name: "recompute-normals", before: rBase, after: r },
  ];
};

for (const op of ["extrude", "bevel", "inset", "subdivide-edges", "subdivide-faces", "loop-cut", "bridge", "fill-hole", "grid-fill", "dissolve-vertices", "dissolve-edges", "dissolve-faces", "merge-by-distance", "heal-manifold", "recompute-normals"] as const) {
  test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")(`${op} snapshot battery`, async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    try {
      const c = [...makeCases(toEditable(Mesh.box({ device, size: 1 }))), ...makeConnectivityCases(), ...makeDissolveCases(), ...makeCleanupCases()].find((v) => v.name === op)!;
      const before = new Map<string, Uint8Array>(), after = new Map<string, Uint8Array>();
      for (const angle of Object.keys(ANGLES) as (keyof typeof ANGLES)[]) {
        const b = await renderEditMesh(device, c.before.toRenderMesh({ device }), angle), a = await renderEditMesh(device, c.after.toRenderMesh({ device }), angle);
        before.set(angle, b); after.set(angle, a);
        await expectEditSnapshot(`${op}-before-${angle}.png`, b);
        await expectEditSnapshot(`${op}-after-${angle}.png`, a);
        expect(sha(b)).not.toBe(sha(a));
      }
      if (c.highlight) {
        const hiBase = c.highlightOn === "before" ? c.before : c.after;
        const hi = await renderEditMesh(device, highlightMesh(device, hiBase, c.highlight), "iso");
        const hiName = c.highlightOn === "before" ? `${op}-before-highlight-iso.png` : `${op}-after-highlight-iso.png`;
        await expectEditSnapshot(hiName, hi);
        expect(sha(hi)).not.toBe(sha((c.highlightOn === "before" ? before : after).get("iso")!));
      }
      for (const set of [before, after]) {
        const hashes = [...set.values()].map(sha);
        expect(new Set(hashes).size).toBe(hashes.length);
      }
    } finally { device.destroy(); }
  });
}

function edgeBetween(em: EditableMeshValue, a: number, b: number): number {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), lo = Math.min(a, b), hi = Math.max(a, b);
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === lo && k.edgeVertexB[e] === hi) return e;
  throw new Error("missing edge");
}

function tintFirstFace(em: EditableMeshValue): void {
  if (em.faceCount) unwrapKernel(em.gpu.halfEdgeKernel).faceNormals.set([0.577, 0.577, 0.577], 0);
}
