import { expect, test } from "vitest";
import { GRADIENT, renderGradientHeadless } from "./example.ts";

test("by-example §13 fixes inputs for deterministic headless rendering", () => {
  expect(GRADIENT).toContain("params.time");
  expect(GRADIENT).toContain("params.speed");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §13 headless Node render is byte-deterministic", async () => {
  const first = await renderGradientHeadless();
  const second = await renderGradientHeadless();
  try {
    const a = await first.target.read();
    const b = await second.target.read();
    expect(Array.from(b)).toEqual(Array.from(a));
  } finally {
    first.gpu.dispose();
    second.gpu.dispose();
  }
});
