import { expect, test } from "vitest";
import { runSharingExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §3 storage resource can be shared into a draw", async () => {
  const { gpu, target } = await runSharingExample();
  try {
    const pixels = await target.read();
    expect(pixels.length).toBe(16 * 16 * 4);
  } finally {
    gpu.dispose();
  }
});
