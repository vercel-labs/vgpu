import { expect, test } from "vitest";
import { COPY, FILL, runPingPongExample } from "./example.ts";

test("by-example §8 separates fill and copy passes for ping-pong target identities", () => {
  expect(FILL).toContain("return vec4f(uv, 0.5, 1.0)");
  expect(COPY).toContain("var src: texture_2d<f32>");
  expect(COPY).toContain("textureLoad(src");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §8 ping-pong alternates target identities", async () => {
  const { gpu, target } = await runPingPongExample();
  try {
    const pixels = await target.read();
    expect(pixels[2]).toBeGreaterThan(100);
  } finally {
    gpu.dispose();
  }
});
