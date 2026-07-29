import { expect, test } from "vitest";
import { init, effect, frame, target } from "../../src/node.ts";

/** HDR values: above 1 (bloom-style), below 0, and exactly representable in binary16. */
const HDR = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(2.5, -1.25, 100.0, 1.0); }
`;

const RED_CHANNEL = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(8.5, 0.0, 0.0, 1.0); }
`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("rgba16float target readback keeps HDR values", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2], format: "rgba16float" });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effect(gpu, HDR))));

    const floats = await colorTarget.readFloats();
    expect(floats).toBeInstanceOf(Float32Array);
    expect(floats).toHaveLength(2 * 2 * 4);
    expect([...floats.subarray(0, 4)]).toEqual([2.5, -1.25, 100, 1]);

    // read() stays raw bytes and is now 8 bytes per texel instead of throwing VGPU-CORE-UNSUPPORTED-FORMAT.
    const bytes = await colorTarget.read();
    expect(bytes.byteLength).toBe(2 * 2 * 8);
  } finally {
    gpu.dispose();
  }
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("rgba32float target readback is exact", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2], format: "rgba32float" });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effect(gpu, HDR))));

    const floats = await colorTarget.readFloats();
    expect(floats).toHaveLength(2 * 2 * 4);
    expect([...floats.subarray(0, 4)]).toEqual([2.5, -1.25, 100, 1]);
    expect((await colorTarget.read()).byteLength).toBe(2 * 2 * 16);
  } finally {
    gpu.dispose();
  }
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("r32float target reads back one component per texel across padded rows", async () => {
  const gpu = await init();
  try {
    // 3 texels per row = 12 bytes, well under the 256-byte copy alignment: exercises row unpadding.
    const colorTarget = target(gpu, { size: [3, 2], format: "r32float" });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effect(gpu, RED_CHANNEL))));

    const floats = await colorTarget.readFloats();
    expect(floats).toHaveLength(3 * 2);
    expect([...floats]).toEqual([8.5, 8.5, 8.5, 8.5, 8.5, 8.5]);
  } finally {
    gpu.dispose();
  }
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("rgba8unorm readback is unchanged and readFloats normalizes it", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2], format: "rgba8unorm" });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effect(gpu, `
      @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
    `))));

    const bytes = await colorTarget.read();
    expect(bytes.byteLength).toBe(2 * 2 * 4);
    expect([...bytes.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...(await colorTarget.readFloats()).subarray(0, 4)]).toEqual([1, 0, 0, 1]);
  } finally {
    gpu.dispose();
  }
});
