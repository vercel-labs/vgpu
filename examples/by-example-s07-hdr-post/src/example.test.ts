import { expect, test } from "vitest";
import { runHdrPostExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §7 HDR target feeds a post pass", async () => {
  const { gpu, output } = await runHdrPostExample();
  try {
    const pixels = await output.read();
    expect(pixels[1]).toBeGreaterThan(100);
    expect(pixels[2]).toBeGreaterThan(150);
  } finally {
    gpu.dispose();
  }
});
