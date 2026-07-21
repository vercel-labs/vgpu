import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init as initBrowser } from "../src/index.ts";
import { registerDrawBundle } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import { createMockAdapter, init } from "../src/mock.ts";

const WAVE = `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, params.time * params.speed, 1.0);
}
`;

const SAMPLER_SHADER = `
@group(0) @binding(0) var samp: sampler;
fn useSampler(value: sampler) {}
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { useSampler(samp); return vec4f(uv, 0.0, 1.0); }
`;

const TEXTURE_SHADER = `
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return textureLoad(src, vec2u(0, 0), 0); }
`;

const CAMERA_SHADER = `
struct Camera { value: f32 }
@group(0) @binding(0) var<uniform> camera: Camera;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(camera.value, uv, 1.0); }
`;

test("set() writes lib-owned values in-place and keeps bind group stable on mock", async () => {
  const gpu = await init();
  const wave = gpu.effect(WAVE, { label: "wave" });
  const target = gpu.target({ size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  wave.set({ speed: 2 });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(wave)));
  wave.set({ time: 0.5 });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(wave)));

  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("creation-time set sugar is exactly an initial set()", async () => {
  const gpu = await init();
  const wave = gpu.effect(WAVE, { label: "wave", set: { speed: 2 } });
  const target = gpu.target({ size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  wave.set({ time: 0.25 });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(wave)));

  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("R1 ownership flip reports canonical fix-it text", async () => {
  const gpu = await init();
  const wave = gpu.effect(WAVE, { label: "wave" });
  wave.set({ speed: 2 });
  const userBuffer = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });

  expect(() => wave.set({ speed: userBuffer })).toThrowError(
    "`speed` is lib-owned by its first JS set(); ownership cannot change. Fix: pass a resource from the start: " +
      "wave.set({ speed: new Uniform(gpu.device, { size: 4 }) }).",
  );
  gpu.dispose();
});

test("binding never set, including samplers, reports canonical no-phantom-resource error", async () => {
  const gpu = await init();
  const lighting = gpu.effect(SAMPLER_SHADER, { label: "lighting" });
  const target = gpu.target({ size: [4, 4] });

  expect(() => gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(lighting)))).toThrowError(
    "Unset `samp` @group(0) @binding(0) in 'lighting'. Fix: lighting.set({samp:gpu.sampler()}); " +
      "or lighting.group(0, bindGroup).",
  );
  gpu.dispose();
});

test("missing texture binding reports a texture-specific fix-it", async () => {
  const gpu = await init();
  const post = gpu.effect(TEXTURE_SHADER, { label: "post" });
  const target = gpu.target({ size: [4, 4] });

  expect(() => gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(post)))).toThrowError(/post\.set\(\{src:scene\.color\}\)/);
  gpu.dispose();
});

test("R2 cache hits when alternating between two user-owned resource identities", async () => {
  const gpu = await init();
  const draw = gpu.effect(CAMERA_SHADER, { label: "cameraPass" });
  const target = gpu.target({ size: [4, 4] });
  const a = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  const b = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  draw.set({ camera: a });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(draw)));
  draw.set({ camera: b });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(draw)));
  draw.set({ camera: a });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(draw)));

  expect(mock.calls.createBindGroup).toBe(2);
  gpu.dispose();
});

test("bundle back-refs stale only on identity changes, never lib-owned in-place writes", async () => {
  const gpu = await init();
  const wave = gpu.effect(WAVE, { label: "wave", set: { speed: 2 } });
  const events: unknown[] = [];
  registerDrawBundle(effectDraw(wave), { id: "bundle", markStale: (event) => { events.push(event); } });

  wave.set({ time: 1 });
  wave.set({ speed: 3 });
  expect(events).toEqual([]);

  const camera = gpu.draw({ shader: CAMERA_SHADER, label: "camera" });
  const a = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  const b = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  camera.set({ camera: a });
  registerDrawBundle(camera, { id: "bundle", markStale: (event) => { events.push(event); } });
  camera.set({ camera: a });
  expect(events).toEqual([]);
  camera.set({ camera: b });
  expect(events).toEqual([expect.objectContaining({ kind: "binding-identity", group: 0, binding: 0, bindingName: "camera" })]);
  gpu.dispose();
});

test("set() accepts Targets as texture resources and uses color texture identity", async () => {
  const gpu = await init();
  const post = gpu.effect(TEXTURE_SHADER, { label: "post" });
  const target = gpu.target({ size: [4, 4] });
  const output = gpu.target({ size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  post.set({ src: target });
  gpu.frame((frame) => frame.pass({ target: output }, (p) => p.draw(post)));

  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("plain draws sampling a resized target rebind with fresh bind groups across repeated resizes and no pipeline creates", async () => {
  const gpu = await init();
  const post = gpu.effect(TEXTURE_SHADER, { label: "post" });
  const source = gpu.target({ size: [4, 4] });
  const output = gpu.target({ size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  post.set({ src: source });
  gpu.frame((frame) => frame.pass({ target: output }, (p) => p.draw(post)));
  const bindGroupsBeforeResize = mock.calls.createBindGroup;
  const pipelinesBeforeResize = mock.calls.createRenderPipeline;
  const asyncPipelinesBeforeResize = mock.calls.createRenderPipelineAsync;

  source.resize([8, 8]);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  gpu.frame((frame) => frame.pass({ target: output }, (p) => p.draw(post)));
  expect(mock.calls.createBindGroup).toBe(bindGroupsBeforeResize + 1);

  source.resize([16, 16]);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  gpu.frame((frame) => frame.pass({ target: output }, (p) => p.draw(post)));
  expect(mock.calls.createBindGroup).toBe(bindGroupsBeforeResize + 2);

  post.set({ src: source });
  source.resize([32, 32]);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  gpu.frame((frame) => frame.pass({ target: output }, (p) => p.draw(post)));
  expect(mock.calls.createBindGroup).toBe(bindGroupsBeforeResize + 3);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  gpu.dispose();
});

test("target recreation subscriptions refresh across repeated resizes and are removed on re-set", async () => {
  const gpu = await init();
  const post = gpu.draw({ shader: TEXTURE_SHADER, label: "post" });
  const sourceA = gpu.target({ size: [4, 4] });
  const sourceB = gpu.target({ size: [4, 4] });
  const sourceC = gpu.target({ size: [4, 4] });
  const events: unknown[] = [];

  post.set({ src: sourceA });
  registerDrawBundle(post, { id: "bundle", markStale: (event) => { events.push(event); } });
  post.set({ src: sourceB });
  events.length = 0;

  sourceA.resize([8, 8]);
  expect(events).toEqual([]);

  sourceB.resize([8, 8]);
  sourceB.resize([16, 16]);
  expect(events).toEqual([
    expect.objectContaining({ kind: "binding-identity", group: 0, binding: 0, bindingName: "src" }),
    expect.objectContaining({ kind: "binding-identity", group: 0, binding: 0, bindingName: "src" }),
  ]);

  post.set({ src: sourceC });
  events.length = 0;
  sourceB.resize([32, 32]);
  expect(events).toEqual([]);

  sourceC.resize([8, 8]);
  expect(events).toEqual([expect.objectContaining({ kind: "binding-identity", group: 0, binding: 0, bindingName: "src" })]);

  events.length = 0;
  sourceC.destroy();
  sourceC.resize([16, 16]);
  expect(events).toEqual([]);
  gpu.dispose();
});

test("resizing a target only drawn onto does not emit bind-group stale events", async () => {
  const gpu = await init();
  const post = gpu.draw({ shader: TEXTURE_SHADER, label: "post" });
  const sampled = gpu.target({ size: [4, 4] });
  const output = gpu.target({ size: [4, 4] });
  const events: unknown[] = [];

  post.set({ src: sampled });
  registerDrawBundle(post, { id: "bundle", markStale: (event) => { events.push(event); } });
  output.resize([8, 8]);

  expect(events).toEqual([]);
  gpu.dispose();
});

test("set() validates resource kind against reflection before WebGPU bind-group creation", async () => {
  const gpu = await init();
  const lighting = gpu.effect(SAMPLER_SHADER, { label: "lighting" });
  const target = gpu.target({ size: [4, 4] });

  expect(() => lighting.set({ samp: target })).toThrowError(/needs sampler/);
  gpu.dispose();
});


test("surface resize reallocates canvas dimensions and notifies on explicit and auto resize", async () => {
  const canvas = mockCanvas(10, 5);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const surface = gpu.surface(canvas, { dpr: 2 });
  const seen: readonly [number, number][] = [];
  surface.onResize(({ width, height }) => { seen.push([width, height]); });

  expect(surface.size).toEqual([20, 10]);
  surface.resize([30, 12]);
  expect(canvas.width).toBe(30);
  expect(canvas.height).toBe(12);
  expect(seen).toEqual([[20, 10], [30, 12]]);

  canvas.clientWidth = 20;
  canvas.clientHeight = 10;
  gpu.frame();
  expect(surface.size).toEqual([40, 20]);
  expect(seen).toEqual([[20, 10], [30, 12], [40, 20]]);
  gpu.dispose();
});

function mockCanvas(clientWidth: number, clientHeight: number): HTMLCanvasElement {
  const canvas = {
    width: 0,
    height: 0,
    clientWidth,
    clientHeight,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        canvas,
        configure() {},
        getCurrentTexture() { throw new Error("not used by resize test"); },
      };
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}
