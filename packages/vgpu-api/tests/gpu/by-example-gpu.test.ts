import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";

const WAVE = `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time * params.speed) * .5 + .5, 1);
}
`;

const POST = `
struct PostParams { texel: vec2f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: PostParams;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(vec2f(uv) / params.texel), 0);
  return vec4f(c.rgb, 1.0);
}
`;

const SOLID = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.25 + uv.x * 0.5, 0.5, 0.75, 1.0);
}
`;

const dockerDawnCompatMode = process.platform === "linux";

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("vgpu ring-1 Docker GPU acceptance", () => {
  test("by-example §2 fullscreen happy path renders via explicit time set", async () => {
    const gpu = await init({ size: [8, 8] });
    try {
      const target = gpu.target({ size: [8, 8], format: "rgba8unorm" });
      const wave = gpu.pass(WAVE, { label: "wave", set: { speed: 2 } });
      wave.set({ time: Math.PI / 4 });
      gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(wave)));
      const pixels = await target.read();
      const pixel = [...pixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
      expect(pixel[2]).toBeGreaterThan(245);
      expect(pixel[3]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });

  test("by-example §7 first half renders HDR target and post pass; rgba8unorm MSAA exercises resolve", async () => {
    const gpu = await init({ size: [8, 8] });
    try {
      const scene = gpu.target({ size: [8, 8], format: "rgba16float", depth: true, label: "scene" });
      expect(scene.sampleCount).toBe(1);
      const msaaScene = gpu.target({ size: [8, 8], format: "rgba8unorm", depth: true, msaa: true, label: "msaaScene" });
      expect(msaaScene.sampleCount).toBe(4);
      expect(msaaScene.color.sampleCount).toBe(1);
      expect(msaaScene.depth?.sampleCount).toBe(4);
      const output = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "output" });
      const solid = gpu.pass(SOLID, { label: "solid" });
      const post = gpu.pass(POST, { label: "post" });
      gpu.frame((frame) => {
        frame.pass({ target: msaaScene, clear: [0, 0, 0, 1] }, (p) => p.draw(solid));
        frame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(solid));
        frame.pass({ target: output }, (p) => {
          post.set({ src: scene, texel: scene.texelSize });
          p.draw(post);
        });
      });
      const msaaPixels = await msaaScene.read();
      const msaaPixel = [...msaaPixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
      expect(msaaPixel[1]).toBeGreaterThan(100);
      expect(msaaPixel[2]).toBeGreaterThan(150);

      const pixels = await output.read();
      const pixel = [...pixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
      expect(pixel[1]).toBeGreaterThan(100);
      expect(pixel[2]).toBeGreaterThan(150);
      expect(pixel[3]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });

  test.skipIf(dockerDawnCompatMode)("by-example §7 exact HDR+MSAA path renders on devices capable of multisampling rgba16float", async () => {
    const gpu = await init({ size: [8, 8] });
    try {
      const scene = gpu.target({ size: [8, 8], format: "rgba16float", depth: true, msaa: true, label: "sceneHdrMsaa" });
      expect(scene.sampleCount).toBe(4);
      const output = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "outputHdrMsaa" });
      const solid = gpu.pass(SOLID, { label: "solidHdrMsaa" });
      const post = gpu.pass(POST, { label: "postHdrMsaa" });
      gpu.frame((frame) => {
        frame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(solid));
        frame.pass({ target: output }, (p) => { post.set({ src: scene, texel: scene.texelSize }); p.draw(post); });
      });
      const pixels = await output.read();
      const pixel = [...pixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
      expect(pixel[1]).toBeGreaterThan(100);
      expect(pixel[2]).toBeGreaterThan(150);
      expect(pixel[3]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });

  test.skipIf(!dockerDawnCompatMode)("Dawn compat mode explicitly rejects rgba16float+msaa instead of silently degrading", async () => {
    const gpu = await init({ size: [8, 8] });
    try {
      expect(() => gpu.target({ size: [8, 8], format: "rgba16float", depth: true, msaa: true, label: "unsupportedHdrMsaa" })).toThrowError(/Dawn compatibility mode/);
    } finally {
      gpu.dispose();
    }
  });
});
