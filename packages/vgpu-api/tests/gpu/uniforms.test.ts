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
    const gpu = await init({ size: [8, 8] });
    try {
      const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
      const wave = gpu.pass(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
      const blur = gpu.pass(BLUR_WGSL, { label: "BLUR_WGSL", set: { g: globals } });
      const waveTarget = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "waveTarget" });
      const blurTarget = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "blurTarget" });

      globals.set({ time: 0.25, mouse: [0.5, 0] });
      gpu.frame((frame) => {
        frame.pass({ target: waveTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(wave));
        frame.pass({ target: blurTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(blur));
      });

      const wavePixels = await waveTarget.read();
      const blurPixels = await blurTarget.read();
      const wavePixel = [...wavePixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
      const blurPixel = [...blurPixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
      expect(wavePixel[0]).toBeGreaterThan(55);
      expect(wavePixel[0]).toBeLessThan(75);
      expect(wavePixel[1]).toBeGreaterThan(120);
      expect(blurPixel[1]).toBeGreaterThan(55);
      expect(blurPixel[1]).toBeLessThan(75);
      expect(blurPixel[2]).toBeGreaterThan(120);
    } finally {
      gpu.dispose();
    }
  });
});
