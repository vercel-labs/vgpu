import { expect, test } from "vitest";
import { FLOOR, runBundlesExample } from "./example.ts";

test("by-example §9 records explicit render bundles around a reflected pass", () => {
  expect(FLOOR).toContain("fogDensity");
  expect(FLOOR).toContain("@fragment fn main");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §9 bundle replay reflects in-place lib-owned uniform updates", async () => {
  const { gpu, before, after } = await runBundlesExample();
  try {
    expect(before[0]).toBeLessThan(80);
    expect(after[0]).toBeGreaterThan(150);
    expect(after[0] - before[0]).toBeGreaterThan(80);
  } finally {
    gpu.dispose();
  }
});
