import { bindGroupLayoutMetadata } from "@vgpu/core";
import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";

const FULLSCREEN = `
struct FullscreenOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> FullscreenOut {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[index];
  var out: FullscreenOut;
  out.position = vec4f(p, 0, 1);
  out.uv = p * 0.5 + 0.5;
  return out;
}
`;
const SOLID = `${FULLSCREEN}
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv.x, 0.6, 0.8, 1.0);
}
`;
const BLOOM_SHAPE = `${FULLSCREEN}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let glow = textureSampleLevel(source, linearSampler, uv, 0.0);
  return vec4f(glow.rgb, 1.0);
}
`;
const LOAD_SHAPE = `${FULLSCREEN}
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(source, vec2i(position.xy), 0);
}
`;
const INSTANCING_BLIT_SHAPE = `${FULLSCREEN}
@group(0) @binding(0) var colorTarget: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(colorTarget, blitSampler, uv);
}
`;

const dockerOnly = process.env.VGPU_DOCKER_TEST !== "1";

describe.skipIf(dockerOnly)("sampler filterability real-world Docker regressions", () => {
  test("post-processing bloom shape promotes rgba8unorm textureSampleLevel and renders", async () => {
    const gpu = await init();
    try {
      await renderSampledFixture(gpu, BLOOM_SHAPE, "post-processing-bloom-shape", "source", "linearSampler");
    } finally {
      gpu.dispose();
    }
  });

  test("instancing blit shape promotes fullscreen rgba8unorm textureSample and renders", async () => {
    const gpu = await init();
    try {
      await renderSampledFixture(gpu, INSTANCING_BLIT_SHAPE, "instancing-blit-shape", "colorTarget", "blitSampler");
    } finally {
      gpu.dispose();
    }
  });

  test("rgba32float textureLoad remains unfilterable and renders without float32-filterable", async () => {
    const gpu = await init();
    try {
      expect(gpu.device.features.has("float32-filterable")).toBe(false);
      const source = gpu.target({ size: [8, 8], format: "rgba32float", label: "load-only-hdr" });
      const output = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "load-only-output" });
      const solid = gpu.draw({ shader: SOLID, vertices: 3 });
      const loaded = gpu.draw({ shader: LOAD_SHAPE, vertices: 3 });
      expect(textureSampleType(loaded.layout(0), 0)).toBe("unfilterable-float");
      expect(() => loaded.set({ source })).not.toThrow();
      gpu.frame((frame) => {
        frame.pass({ target: source }, (pass) => pass.draw(solid));
        frame.pass({ target: output }, (pass) => pass.draw(loaded));
      });
      expect(pixelAt(await output.read(), 8, 4, 4)[1]).toBeGreaterThan(100);
    } finally { gpu.dispose(); }
  });

  test("rgba32float ordinary sampling reports the structured facade error before native validation", async () => {
    const gpu = await init();
    try {
      const source = gpu.target({ size: [1, 1], format: "rgba32float", label: "sampled-hdr" });
      const sampled = gpu.draw({ shader: BLOOM_SHAPE, label: "sampled-hdr-draw", vertices: 3 });
      expect(() => sampled.set({ source, linearSampler: gpu.sampler() })).toThrow(expect.objectContaining({
        code: "VGPU-SET-TEXTURE-FILTERABILITY",
        detail: expect.objectContaining({ format: "rgba32float", bindingName: "source", samplerName: "linearSampler" }),
      }));
    } finally { gpu.dispose(); }
  });
});

async function renderSampledFixture(
  gpu: Awaited<ReturnType<typeof init>>,
  shader: string,
  label: string,
  textureName: string,
  samplerName: string,
): Promise<void> {
  const source = gpu.target({ size: [8, 8], format: "rgba8unorm", label: `${label}-source` });
  const output = gpu.target({ size: [8, 8], format: "rgba8unorm", label: `${label}-output` });
  const solid = gpu.draw({ shader: SOLID, label: `${label}-solid`, vertices: 3 });
  const sampled = gpu.draw({ shader, label, vertices: 3 });
  expect(textureSampleType(sampled.layout(0), 0)).toBe("float");
  sampled.set({ [textureName]: source, [samplerName]: gpu.sampler({ minFilter: "linear", magFilter: "linear" }) });
  gpu.frame((frame) => {
    frame.pass({ target: source }, (pass) => pass.draw(solid));
    frame.pass({ target: output }, (pass) => pass.draw(sampled));
  });
  const pixel = pixelAt(await output.read(), 8, 4, 4);
  expect(pixel[1]).toBeGreaterThan(100);
  expect(pixel[2]).toBeGreaterThan(150);
  expect(pixel[3]).toBe(255);
}

function textureSampleType(layout: GPUBindGroupLayout, binding: number): GPUTextureSampleType | undefined {
  return bindGroupLayoutMetadata(layout)?.entries.find((entry) => entry.binding === binding)?.texture?.sampleType;
}

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): readonly number[] {
  return [...pixels.slice(4 * (y * width + x), 4 * (y * width + x) + 4)];
}
