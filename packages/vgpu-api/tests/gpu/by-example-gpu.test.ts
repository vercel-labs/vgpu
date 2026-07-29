import { describe, expect, test } from "vitest";
import { init, effect, frame, target } from "../../src/node.ts";

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
    const gpu = await init();
    try {
      const colorTarget = target(gpu, { size: [8, 8], format: "rgba8unorm" });
      const wave = effect(gpu, WAVE, { label: "wave", set: { speed: 2 } });
      wave.set({ time: Math.PI / 4 });
      frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(wave)));
      const pixels = await colorTarget.read();
      const pixel = [...pixels.slice(4 * (4 * 8 + 4), 4 * (4 * 8 + 4) + 4)];
      expect(pixel[2]).toBeGreaterThan(245);
      expect(pixel[3]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });

  test("by-example §7 first half renders HDR target and post pass; rgba8unorm MSAA exercises resolve", async () => {
    const gpu = await init();
    try {
      const scene = target(gpu, { size: [8, 8], format: "rgba16float", depth: true, label: "scene" });
      expect(scene.sampleCount).toBe(1);
      const msaaScene = target(gpu, { size: [8, 8], format: "rgba8unorm", depth: true, msaa: true, label: "msaaScene" });
      expect(msaaScene.sampleCount).toBe(4);
      expect(msaaScene.color.sampleCount).toBe(1);
      expect(msaaScene.depth?.sampleCount).toBe(4);
      const output = target(gpu, { size: [8, 8], format: "rgba8unorm", label: "output" });
      const solid = effect(gpu, SOLID, { label: "solid" });
      const post = effect(gpu, POST, { label: "post" });
      frame(gpu, (currentFrame) => {
        currentFrame.pass({ target: msaaScene, clear: [0, 0, 0, 1] }, (p) => p.draw(solid));
        currentFrame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(solid));
        currentFrame.pass({ target: output }, (p) => {
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
    const gpu = await init();
    try {
      const scene = target(gpu, { size: [8, 8], format: "rgba16float", depth: true, msaa: true, label: "sceneHdrMsaa" });
      expect(scene.sampleCount).toBe(4);
      const output = target(gpu, { size: [8, 8], format: "rgba8unorm", label: "outputHdrMsaa" });
      const solid = effect(gpu, SOLID, { label: "solidHdrMsaa" });
      const post = effect(gpu, POST, { label: "postHdrMsaa" });
      frame(gpu, (currentFrame) => {
        currentFrame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(solid));
        currentFrame.pass({ target: output }, (p) => { post.set({ src: scene, texel: scene.texelSize }); p.draw(post); });
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
    const gpu = await init();
    try {
      expect(() => target(gpu, { size: [8, 8], format: "rgba16float", depth: true, msaa: true, label: "unsupportedHdrMsaa" })).toThrowError(/Dawn compatibility mode/);
    } finally {
      gpu.dispose();
    }
  });
});
