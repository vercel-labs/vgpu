import { expect, test } from "vitest";
import { compareVisualSnapshot } from "../../../../scripts/lib/visual-snapshot.mjs";
import { createNodeAdapter } from "@vgpu/adapter-node";

import { perspectiveCamera, type Vec3 } from "vgpu/scene";
import { meshToWireframe, wireframeMaterial } from "@vgpu/render/inspect";
import { createReadableBoxMesh, renderInspectFrame } from "./helpers.ts";

const SNAPSHOT_DIR = "packages/render/tests/inspect/__snapshots__";
const CAMERAS = {
  front: { position: [0, 0.5, 3] as const },
  iso: { position: [2, 2, 3] as const },
  side: { position: [3, 0.75, 0.25] as const },
} as const;

for (const [angle, { position }] of Object.entries(CAMERAS)) {
  test.skipIf(!process.env.VGPU_SNAPSHOT_MODE)(`wireframe ${angle} matches snapshot`, async () => {
    const device = await createNodeAdapter().requestDevice();
    try {
      const mesh = createReadableBoxMesh(device, 1);
      const wireframe = await meshToWireframe(mesh, device);
      const material = wireframeMaterial({ device, color: [1, 1, 1], targetFormat: "rgba8unorm-srgb" });
      const camera = perspectiveCamera({
        fov: 45,
        aspect: 1,
        near: 0.1,
        far: 100,
        position: vec3(position),
        target: vec3([0, 0, 0]),
      });

      const pngBytes = await renderInspectFrame({
        device,
        material,
        vertexBuffer: mesh.vertexBuffer.gpu,
        vertexCount: mesh.vertexCount,
        indexBuffer: wireframe.indexBuffer,
        indexFormat: wireframe.indexFormat,
        indexCount: wireframe.lineCount * 2,
        camera,
        targetFormat: "rgba8unorm-srgb",
      });
      await expectSnapshot(`box-wireframe-${angle}.png`, pngBytes);
    } finally {
      device.destroy();
    }
  });
}

async function expectSnapshot(name: string, pngBytes: Uint8Array): Promise<void> {
  await compareVisualSnapshot(SNAPSHOT_DIR, name, pngBytes, { onMismatch: (message: string) => expect.soft(false, message).toBe(true) });
}

function vec3(values: readonly [number, number, number]): Vec3 {
  return new Float32Array(values) as Vec3;
}
