import { expect, test } from "vitest";
import { runGroupClaimExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §10 group claim accepts dynamic offsets at draw time", async () => {
  const { gpu, target } = await runGroupClaimExample();
  try {
    const pixels = await target.read();
    expect(pixels[0]).toBeGreaterThan(180);
  } finally {
    gpu.dispose();
  }
});
