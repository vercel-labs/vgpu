import { test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import {
  assertAllDistinct,
  expectSnapshot,
  primitiveCamera,
  renderPrimitiveFrame,
  type PrimitiveCameraAngle,
  type PrimitiveMaterialVariant,
} from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("box primitive snapshot battery matches", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  try {
    const pngs: Record<string, Uint8Array> = {};
    for (const material of MATERIALS) {
      for (const angle of ANGLES) {
        const name = `box-${material}-${angle}.png`;
        pngs[name] = await renderPrimitiveFrame({
          device,
          mesh: Mesh.box({ device, size: 1 }),
          camera: primitiveCamera(angle),
          material,
          baseColor: [0.7, 0.55, 0.45],
        });
      }
    }
    assertAllDistinct(pngs);
    for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes);
  } finally {
    device.destroy();
  }
});
