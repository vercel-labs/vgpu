import * as THREE from "three/webgpu";
import { expect, it } from "vitest";

import surfaceModule from "./surface.wgsl";
import { createScene } from "./renderer";

it("turns a complete WGSL artifact into a Three physical material", () => {
  expect(surfaceModule.functionExports).toEqual([
    {
      name: "surfaceColor",
      resolvedName: expect.any(String),
      parameterNames: ["position"],
    },
  ]);

  const demo = createScene(1);
  expect(demo.mesh.material).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
  expect(demo.material.colorNode?.isNode).toBe(true);
  demo.dispose();
});
