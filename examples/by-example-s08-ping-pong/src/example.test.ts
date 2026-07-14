import { expect, test } from "vitest";
import { runPingPongExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §8 ping-pong alternates target identities", async () => {
  const { gpu, target } = await runPingPongExample();
  try {
    const pixels = await target.read();
    expect(pixels[2]).toBeGreaterThan(100);
  } finally {
    gpu.dispose();
  }
});
