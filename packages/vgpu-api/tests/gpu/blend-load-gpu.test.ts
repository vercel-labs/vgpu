import { expect, test } from "vitest";
import { init, effect, frame, target } from "../../src/node.ts";

const FULLSCREEN_RED = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.25, 0.0, 0.0, 0.25); }
`;

const FULLSCREEN_ALPHA = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
`;

const HALF_GREEN = `
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  if (position.x >= 2.0) { discard; }
  return vec4f(0.0, 1.0, 0.0, 1.0);
}
`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("additive blend accumulates repeated fullscreen draws", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2], format: "rgba8unorm" });
    const additive = effect(gpu, FULLSCREEN_RED, { label: "additive", blend: "additive" });

    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => {
      pass.draw(additive);
      pass.draw(additive);
    }));

    const px = await colorTarget.read();
    expect(px[0]).toBeGreaterThanOrEqual(126);
    expect(px[0]).toBeLessThanOrEqual(129);
    expect(px[1]).toBe(0);
    expect(px[2]).toBe(0);
  } finally {
    gpu.dispose();
  }
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("writeMask can preserve alpha while writing rgb", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2], format: "rgba8unorm" });
    const rgbOnly = effect(gpu, FULLSCREEN_ALPHA, { label: "rgb-only", writeMask: ["r", "g", "b"] });

    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 0.5] }, (pass) => pass.draw(rgbOnly)));

    const px = await colorTarget.read();
    expect(px[0]).toBe(255);
    expect(px[1]).toBe(0);
    expect(px[2]).toBe(0);
    expect(px[3]).toBeGreaterThanOrEqual(126);
    expect(px[3]).toBeLessThanOrEqual(129);
  } finally {
    gpu.dispose();
  }
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("MSAA target resolves additive blend", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2], format: "rgba8unorm", msaa: true });
    const additive = effect(gpu, FULLSCREEN_RED, { label: "msaa-additive", blend: "additive" });

    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => {
      pass.draw(additive);
      pass.draw(additive);
    }));

    const px = await colorTarget.read();
    expect(px[0]).toBeGreaterThanOrEqual(126);
    expect(px[0]).toBeLessThanOrEqual(129);
    expect(px[1]).toBe(0);
    expect(px[2]).toBe(0);
  } finally {
    gpu.dispose();
  }
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("clear false preserves offscreen target contents across passes and frames", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [4, 2], format: "rgba8unorm" });
    const halfGreen = effect(gpu, HALF_GREEN, { label: "half-green" });

    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [1, 0, 0, 1] }, () => undefined));
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: false }, (pass) => pass.draw(halfGreen)));

    const px = await colorTarget.read();
    const left = 0;
    const right = (4 - 1) * 4;
    expect([...px.slice(left, left + 4)]).toEqual([0, 255, 0, 255]);
    expect([...px.slice(right, right + 4)]).toEqual([255, 0, 0, 255]);
  } finally {
    gpu.dispose();
  }
});
