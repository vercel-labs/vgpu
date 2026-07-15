import { createMockAdapter } from "@vgpu/adapter-mock";

import { Mesh } from "../../../vgpu-api/src/scene/geometry-src/mesh.ts";
import { bevel, bridge, dissolveEdges, dissolveFaces, dissolveVertices, extrude, fillHole, gridFill, healManifold, inset, loopCut, mergeByDistance, recomputeNormals, subdivideEdges, subdivideFaces, toEditable, type EditableMeshValue } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { bentSmoothPair, mergeDuplicateTetra, nonManifoldTetra } from "./fixtures/cleanup.ts";
import { openCube, plateLoops, topHoleLoop, twoPlates } from "./fixtures/connectivity.ts";
import { octahedron } from "./fixtures/dissolve.ts";

const ops = ["extrude", "bevel", "inset", "subdivideEdges", "subdivideFaces", "loopCut", "bridge", "fillHole", "gridFill", "dissolveVertices", "dissolveEdges", "dissolveFaces", "mergeByDistance", "healManifold", "recomputeNormals"] as const;

describe("all mesh edit operators smoke", () => {
  for (const name of ops) test(`${name} is exported and bakes to Mesh`, async () => {
    const device = await createMockAdapter().requestDevice();
    try {
      const mesh = run(name, toEditable(Mesh.box({ device, size: 1 })));
      expect(() => mesh.toRenderMesh({ device })).not.toThrow();
    } finally {
      device.destroy();
    }
  });
});

function run(name: typeof ops[number], box: EditableMeshValue): EditableMeshValue {
  if (name === "extrude") return extrude(box, box.faces.scoreBy((f) => f.center[1]).top(), { distance: 0.2 }).mesh;
  if (name === "bevel") return bevel(box, box.hardEdges, { offset: 0.04 }).mesh;
  if (name === "inset") return inset(box, box.faces.scoreBy((f) => f.center[1]).top(), { thickness: 0.15 }).mesh;
  if (name === "subdivideEdges") return subdivideEdges(box, box.edges.byIndex([0])).mesh;
  if (name === "subdivideFaces") return subdivideFaces(box, box.faces.byIndex([0])).mesh;
  if (name === "loopCut") return loopCut(box, box.edges.byIndex([0]).indices[0]).mesh;
  if (name === "bridge") { const em = twoPlates(); return bridge(em, plateLoops(em)).mesh; }
  if (name === "fillHole") { const em = openCube(); return fillHole(em, topHoleLoop(em)).mesh; }
  if (name === "gridFill") { const em = openCube(); return gridFill(em, topHoleLoop(em)).mesh; }
  if (name === "dissolveVertices") { const em = octahedron(); return dissolveVertices(em, em.vertices.byIndex([0])).mesh; }
  if (name === "dissolveEdges") { const em = octahedron(); return dissolveEdges(em, em.edges.byIndex([0])).mesh; }
  if (name === "dissolveFaces") { const em = octahedron(); return dissolveFaces(em, em.faces.byIndex([0, 1])).mesh; }
  if (name === "mergeByDistance") { const em = mergeDuplicateTetra(); return mergeByDistance(em, { selection: em.vertices.byIndex([0, 4]), threshold: 0.3 }).mesh; }
  if (name === "healManifold") return healManifold(nonManifoldTetra()).mesh;
  return recomputeNormals(bentSmoothPair());
}
