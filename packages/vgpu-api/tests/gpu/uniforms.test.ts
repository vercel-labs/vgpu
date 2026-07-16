import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";

const WAVE_WGSL = `
struct Globals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<uniform> globals: Globals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(globals.time, globals.mouse.x, 0.0, 1.0);
}
`;

const BLUR_WGSL = `
struct BlurGlobals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<uniform> g: BlurGlobals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.0, globalsValue(), globalsMouse(), 1.0);
}
fn globalsValue() -> f32 { return g.time; }
fn globalsMouse() -> f32 { return g.mouse.x; }
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("gpu.uniforms() Docker GPU", () => {
  test("wave and blur share one animated globals object", async () => {
    const gpu = await init();
    const createBufferCount = countCreateBufferCalls(gpu.gpu);
    try {
      const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
      const wave = gpu.effect(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
      const blur = gpu.effect(BLUR_WGSL, { label: "BLUR_WGSL", set: { g: globals } });
      const waveTarget = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "waveTarget" });
      const blurTarget = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "blurTarget" });

      globals.set({ time: 0.25, mouse: [0.5, 0] });
      renderPair(gpu, waveTarget, blurTarget, wave, blur);
      const firstWavePixel = await centerPixel(waveTarget);
      const firstBlurPixel = await centerPixel(blurTarget);

      globals.set({ time: 0.75 });
      renderPair(gpu, waveTarget, blurTarget, wave, blur);
      const secondWavePixel = await centerPixel(waveTarget);
      const secondBlurPixel = await centerPixel(blurTarget);

      expect(firstWavePixel[0]).toBeGreaterThan(55);
      expect(firstWavePixel[0]).toBeLessThan(75);
      expect(firstWavePixel[1]).toBeGreaterThan(120);
      expect(secondWavePixel[0]).toBeGreaterThan(180);
      expect(secondWavePixel[0]).toBeLessThan(205);
      expect(secondWavePixel[1]).toBe(firstWavePixel[1]);
      expect(secondWavePixel[0]).toBeGreaterThan(firstWavePixel[0]);

      expect(firstBlurPixel[1]).toBeGreaterThan(55);
      expect(firstBlurPixel[1]).toBeLessThan(75);
      expect(firstBlurPixel[2]).toBeGreaterThan(120);
      expect(secondBlurPixel[1]).toBeGreaterThan(180);
      expect(secondBlurPixel[1]).toBeLessThan(205);
      expect(secondBlurPixel[2]).toBe(firstBlurPixel[2]);
      expect(secondBlurPixel[1]).toBeGreaterThan(firstBlurPixel[1]);
      expect(createBufferCount()).toBe(1);
    } finally {
      gpu.dispose();
    }
  });
});

function renderPair(gpu: Awaited<ReturnType<typeof init>>, waveTarget: ReturnType<typeof gpu.target>, blurTarget: ReturnType<typeof gpu.target>, wave: ReturnType<typeof gpu.effect>, blur: ReturnType<typeof gpu.effect>): void {
  gpu.frame((frame) => {
    frame.pass({ target: waveTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(wave));
    frame.pass({ target: blurTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(blur));
  });
}

async function centerPixel(target: ReturnType<Awaited<ReturnType<typeof init>>["target"]>): Promise<readonly number[]> {
  const pixels = await target.read();
  return [...pixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
}

function countCreateBufferCalls(device: GPUDevice): () => number {
  let count = 0;
  const original = device.createBuffer.bind(device);
  device.createBuffer = ((descriptor: GPUBufferDescriptor) => {
    if (descriptor.label === "globals.sharedUniform") count += 1;
    return original(descriptor);
  }) as GPUDevice["createBuffer"];
  return () => count;
}
