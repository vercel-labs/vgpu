import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { degToRad, perspectiveCamera, type Vec3 } from "@vgpu/render";
import { meshToWireframe, wireframeMaterial } from "@vgpu/render/inspect";
import { createReadableBoxMesh, renderInspectFrame } from "./_helpers.ts";

const WIDTH = 256;
const HEIGHT = 256;
const SNAPSHOT_DIR = "packages/render/tests/inspect/__snapshots__";
const CAMERAS = {
  front: { position: [0, 0.5, 3] as const },
  iso: { position: [2, 2, 3] as const },
  side: { position: [3, 0.75, 0.25] as const },
} as const;

for (const [angle, { position }] of Object.entries(CAMERAS)) {
  test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")(`wireframe ${angle} matches snapshot`, async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    try {
      const mesh = createReadableBoxMesh(device, 1);
      const wireframe = await meshToWireframe(mesh, device);
      const material = wireframeMaterial({ device, color: [1, 1, 1], targetFormat: "rgba8unorm-srgb" });
      const camera = perspectiveCamera({
        fovYRadians: degToRad(45),
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
  const expectedPath = join(process.cwd(), SNAPSHOT_DIR, name);
  if (process.env.VGPU_WRITE_SNAPSHOTS === "1") {
    await mkdir(join(process.cwd(), SNAPSHOT_DIR), { recursive: true });
    await writeFile(expectedPath, pngBytes);
    return;
  }
  const expected = PNG.sync.read(await readFile(expectedPath));
  const actual = PNG.sync.read(Buffer.from(pngBytes));
  expect(actual.width).toBe(WIDTH);
  expect(actual.height).toBe(HEIGHT);
  expect(expected.width).toBe(WIDTH);
  expect(expected.height).toBe(HEIGHT);
  const mismatched = pixelmatch(actual.data, expected.data, null, WIDTH, HEIGHT, { threshold: 0.001 });
  expect(mismatched).toBe(0);
}

function vec3(values: readonly [number, number, number]): Vec3 {
  return new Float32Array(values) as Vec3;
}
