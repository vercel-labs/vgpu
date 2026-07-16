import { resolve } from "node:path";
import { expect, test } from "vitest";
import { init } from "../../src/node.ts";
import { comparePixelSnapshot } from "../../test-utils/snapshot.ts";
import { REPRESENTATIVE_GRADIENT_WGSL, SNAPSHOT_SIZE } from "../fixtures/representative-gradient.ts";

const BASELINE = resolve(import.meta.dirname, "../__snapshots__/representative-gradient.png");

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("representative gradient matches committed pixel baseline", async () => {
  const gpu = await init();
  try {
    const target = gpu.target({ size: SNAPSHOT_SIZE, format: "rgba8unorm", label: "representative-gradient" });
    const effect = gpu.effect(REPRESENTATIVE_GRADIENT_WGSL, { label: "representative-gradient", set: { speed: 2 } });
    effect.set({ time: Math.PI / 4 });
    gpu.frame((frame) => frame.pass({ target }, (encoder) => encoder.draw(effect)));
    const result = await comparePixelSnapshot(BASELINE, await target.read(), SNAPSHOT_SIZE[0], SNAPSHOT_SIZE[1]);
    expect(result).toMatchObject({ status: "matched", mismatchedPixels: 0, ratio: 0 });
  } finally {
    gpu.dispose();
  }
});
