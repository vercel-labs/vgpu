import { expect, test } from "vitest";
import { CLAIMED, runGroupClaimExample } from "./example.ts";

test("by-example §10 shader exposes a whole claimed bind group layout", () => {
  expect(CLAIMED).toContain("@group(0) @binding(0) var<uniform> params");
  expect(CLAIMED).toContain("struct Params { color: vec4f }");
  expect(CLAIMED).toContain("return params.color");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §10 group claim accepts dynamic offsets at draw time", async () => {
  const { gpu, target } = await runGroupClaimExample();
  try {
    const pixels = await target.read();
    expect(pixels[0]).toBeGreaterThan(180);
  } finally {
    gpu.dispose();
  }
});
