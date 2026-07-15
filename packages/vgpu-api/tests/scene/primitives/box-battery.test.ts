import { test } from "vitest";
import { init as initMock } from "../../../src/mock.ts";
import { init as initNode } from "../../../src/node.ts";
import { Mesh } from "../../../src/scene/geometry-src/index.ts";
import {
  assertAllDistinct,
  expectSnapshot,
  primitiveCamera,
  renderPrimitiveFrame,
  type PrimitiveCameraAngle,
  type PrimitiveMaterialVariant,
} from "./helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normal-debug-32"];

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("box primitive snapshot battery matches", async () => {
  const { device } = await initNode();
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
