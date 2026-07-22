import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";

const SIZE = 8;

const UV_PATTERN = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv.y, 1.0 - uv.y, step(0.5, uv.y), 1.0);
}
`;

const IDENTITY_COPY = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(src, srcSampler, uv, 0.0);
}
`;

const WGSL_STD_ORIENTATION = `
struct FullscreenOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> FullscreenOut {
  let x = f32(index >> 1u) * 4.0 - 1.0;
  let y = f32(min(index, 1u)) * 4.0 - 3.0;
  var out: FullscreenOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = out.position.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  return out;
}
${UV_PATTERN}
`;

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";

describe.skipIf(!dockerTest)("fragment-only effect UV orientation", () => {
  test("uses v=0 for the top row", async () => {
    const gpu = await init();
    try {
      const target = gpu.target({ size: [SIZE, SIZE], format: "rgba8unorm" });
      gpu.effect(UV_PATTERN).draw(target);

      const pixels = await target.read();
      const top = pixelAt(pixels, 0, 0);
      const bottom = pixelAt(pixels, 0, SIZE - 1);
      expect(top[0]).toBeLessThan(32);
      expect(top[1]).toBeGreaterThan(223);
      expect(top[2]).toBe(0);
      expect(bottom[0]).toBeGreaterThan(223);
      expect(bottom[1]).toBeLessThan(32);
      expect(bottom[2]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });

  test("copies a target pixel-for-pixel when sampling at the injected uv", async () => {
    const gpu = await init();
    try {
      const source = gpu.target({ size: [SIZE, SIZE], format: "rgba8unorm" });
      const output = gpu.target({ size: [SIZE, SIZE], format: "rgba8unorm" });
      gpu.effect(UV_PATTERN).draw(source);
      gpu.effect(IDENTITY_COPY, {
        set: {
          src: source,
          srcSampler: gpu.sampler({ minFilter: "nearest", magFilter: "nearest" }),
        },
      }).draw(output);

      expect(await output.read()).toEqual(await source.read());
    } finally {
      gpu.dispose();
    }
  });

  test("matches the @vgpu/wgsl-std fullscreenTriangleUv orientation", async () => {
    const gpu = await init();
    try {
      const injected = gpu.target({ size: [SIZE, SIZE], format: "rgba8unorm" });
      const helper = gpu.target({ size: [SIZE, SIZE], format: "rgba8unorm" });
      gpu.effect(UV_PATTERN).draw(injected);
      gpu.draw({ shader: WGSL_STD_ORIENTATION, vertices: 3 }).draw(helper);

      expect(await injected.read()).toEqual(await helper.read());
    } finally {
      gpu.dispose();
    }
  });
});

function pixelAt(pixels: Uint8Array, x: number, y: number): readonly number[] {
  const offset = 4 * (y * SIZE + x);
  return [...pixels.slice(offset, offset + 4)];
}
