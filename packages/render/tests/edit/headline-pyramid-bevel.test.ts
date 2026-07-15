import { createNodeAdapter } from "@vgpu/adapter-node";

import { Mesh } from "../../../vgpu-api/src/scene/geometry-src/mesh.ts";
import { bevel, toEditable } from "@vgpu/render/edit";
import { describe, expect, test } from "vitest";
import { ANGLES, expectEditSnapshot, renderEditMesh, sha } from "./_helpers.ts";

const HAS_CONE = typeof (Mesh as unknown as { cone?: unknown }).cone === "function";
const skipMessage = "user headline scene deferred — requires Mesh.cone from geometry-primitives PR (issue #32)";

describe("issue #34 headline pyramid+bevel scene availability", () => {
  if (HAS_CONE) test("Mesh.cone is available", () => expect(HAS_CONE).toBe(true));
  else test.skip(skipMessage, () => undefined);
});

(HAS_CONE ? describe : describe.skip)("issue #34 headline pyramid+bevel scene", () => {
  test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("renders the pyramid+bevel scene byte-equal to snapshot", async () => {
    const device = await createNodeAdapter().requestDevice();
    try {
      const cone = (Mesh as unknown as { cone: (opts: unknown) => Mesh }).cone;
      const pyramid = cone({ device, radius: 0.5, height: 1, radialSegments: 4 });
      const em = toEditable(pyramid);
      const sharp = em.edges.where((e) => e.isSharp);
      const result = bevel(em, sharp, { offset: 0.1, segments: 1 });
      const beveledPyramid = result.mesh.toRenderMesh({ device });
      const frames = new Map<string, Uint8Array>();
      // The edit snapshot helper uses normal-debug material; this matches the operator battery until PBR is available on this branch.
      for (const angle of Object.keys(ANGLES) as (keyof typeof ANGLES)[]) {
        const frame = await renderEditMesh(device, beveledPyramid, angle);
        frames.set(angle, frame);
        await expectEditSnapshot(`headline-pyramid-bevel-${angle}.png`, frame);
      }
      expect(new Set([...frames.values()].map(sha)).size).toBe(frames.size);
    } finally {
      device.destroy();
    }
  });
});
