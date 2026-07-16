import { expect, test } from "vitest";
import { runComputeExample, SIM } from "./example.ts";

test("by-example §11 compute shader declares uniform params plus src/dst storage buffers", () => {
  expect(SIM).toContain("@compute @workgroup_size(1)");
  expect(SIM).toContain("var<uniform> sim");
  expect(SIM).toContain("var<storage, read> src");
  expect(SIM).toContain("var<storage, read_write> dst");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §11 compute dispatch writes storage", async () => {
  const { gpu, dst } = await runComputeExample();
  try {
    const data = new Float32Array(await dst.read(16));
    expect(data[0]).toBeCloseTo(1);
    expect(data[1]).toBeLessThan(-2);
  } finally {
    gpu.dispose();
  }
});
