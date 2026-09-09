import { describe, expect, test } from "vitest";
import { draw, effect, frame, init, sampler, target } from "../../src/node.ts";

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

const ISSUE_399_OTHER = `@fragment fn other(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`;
const ISSUE_399_MAIN = `@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }`;

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
  test("prefers fs_main over an earlier fragment entry (#399)", async () => {
    const gpu = await init();
    try {
      const colorTarget = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const render = async (source: string) => {
        const shader = effect(gpu, source);
        frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, shader));
        return [...(await colorTarget.read()).slice(0, 4)];
      };

      expect(await render(`${ISSUE_399_OTHER}\n${ISSUE_399_MAIN}`)).toEqual([0, 255, 0, 255]);
      expect(await render(`${ISSUE_399_MAIN}\n${ISSUE_399_OTHER}`)).toEqual([0, 255, 0, 255]);
      expect(await render(ISSUE_399_OTHER)).toEqual([255, 0, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("uses v=0 for the top row", async () => {
    const gpu = await init();
    try {
      const colorTarget = target(gpu, { size: [SIZE, SIZE], format: "rgba8unorm" });
      effect(gpu, UV_PATTERN).draw(colorTarget);

      const pixels = await colorTarget.color.read({ mipLevel: 0, region: "all" });
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
      const source = target(gpu, { size: [SIZE, SIZE], format: "rgba8unorm" });
      const output = target(gpu, { size: [SIZE, SIZE], format: "rgba8unorm" });
      effect(gpu, UV_PATTERN).draw(source);
      effect(gpu, IDENTITY_COPY, {
        set: {
          src: source,
          srcSampler: sampler(gpu, { minFilter: "nearest", magFilter: "nearest" }),
        },
      }).draw(output);

      expect(await output.color.read({ mipLevel: 0, region: "all" })).toEqual(await source.color.read({ mipLevel: 0, region: "all" }));
    } finally {
      gpu.dispose();
    }
  });

  test("matches the @vgpu/wgsl-std fullscreenTriangleUv orientation", async () => {
    const gpu = await init();
    try {
      const injected = target(gpu, { size: [SIZE, SIZE], format: "rgba8unorm" });
      const helper = target(gpu, { size: [SIZE, SIZE], format: "rgba8unorm" });
      effect(gpu, UV_PATTERN).draw(injected);
      draw(gpu, { shader: WGSL_STD_ORIENTATION, vertices: 3 }).draw(helper);

      expect(await injected.color.read({ mipLevel: 0, region: "all" })).toEqual(await helper.color.read({ mipLevel: 0, region: "all" }));
    } finally {
      gpu.dispose();
    }
  });
});

function pixelAt(pixels: Uint8Array, x: number, y: number): readonly number[] {
  const offset = 4 * (y * SIZE + x);
  return [...pixels.slice(offset, offset + 4)];
}
