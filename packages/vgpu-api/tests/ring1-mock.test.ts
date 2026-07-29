import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init as initBrowser } from "../src/index.ts";
import { draw, registerDrawBundle } from "../src/draw.ts";
import { effect, effectDraw, fullscreenSource } from "../src/effect.ts";
import { createMockAdapter, init } from "../src/mock.ts";
import { bundle } from "../src/bundle.ts";
import { clock } from "../src/clock.ts";
import { frame, frameLoop } from "../src/frame.ts";
import { kernelOf } from "../src/kernel.ts";
import { renderServiceToken } from "../src/render-service.ts";
import { sampler } from "../src/sampler.ts";
import { surface } from "../src/surface.ts";
import { target } from "../src/target-offscreen.ts";

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
  const wave = effect(gpu, WAVE, { label: "wave" });
  const colorTarget = target(gpu, { size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  wave.set({ speed: 2 });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(wave)));
  wave.set({ time: 0.5 });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(wave)));

  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("creation-time set sugar is exactly an initial set()", async () => {
  const gpu = await init();
  const wave = effect(gpu, WAVE, { label: "wave", set: { speed: 2 } });
  const colorTarget = target(gpu, { size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  wave.set({ time: 0.25 });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(wave)));

  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("R1 ownership flip reports canonical fix-it text", async () => {
  const gpu = await init();
  const wave = effect(gpu, WAVE, { label: "wave" });
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
  const lighting = effect(gpu, SAMPLER_SHADER, { label: "lighting" });
  const colorTarget = target(gpu, { size: [4, 4] });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(lighting)))).toThrowError(
    "Unset `samp` @group(0) @binding(0) in 'lighting'. Fix: lighting.set({samp:sampler(gpu)}); " +
      "or lighting.group(0, bindGroup).",
  );
  gpu.dispose();
});

test("missing texture binding reports a texture-specific fix-it", async () => {
  const gpu = await init();
  const post = effect(gpu, TEXTURE_SHADER, { label: "post" });
  const colorTarget = target(gpu, { size: [4, 4] });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(post)))).toThrowError(/post\.set\(\{src:scene\.color\}\)/);
  gpu.dispose();
});

test("R2 cache hits when alternating between two user-owned resource identities", async () => {
  const gpu = await init();
  const drawable = effect(gpu, CAMERA_SHADER, { label: "cameraPass" });
  const colorTarget = target(gpu, { size: [4, 4] });
  const a = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  const b = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  drawable.set({ camera: a });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(drawable)));
  drawable.set({ camera: b });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(drawable)));
  drawable.set({ camera: a });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(drawable)));

  expect(mock.calls.createBindGroup).toBe(2);
  gpu.dispose();
});

test("bundle back-refs stale only on identity changes, never lib-owned in-place writes", async () => {
  const gpu = await init();
  const wave = effect(gpu, WAVE, { label: "wave", set: { speed: 2 } });
  const events: unknown[] = [];
  registerDrawBundle(effectDraw(wave), { id: "bundle", markStale: (event) => { events.push(event); } });

  wave.set({ time: 1 });
  wave.set({ speed: 3 });
  expect(events).toEqual([]);

  const camera = draw(gpu, { shader: CAMERA_SHADER, label: "camera" });
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
  const post = effect(gpu, TEXTURE_SHADER, { label: "post" });
  const colorTarget = target(gpu, { size: [4, 4] });
  const output = target(gpu, { size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  post.set({ src: colorTarget });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: output }, (p) => p.draw(post)));

  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("plain draws sampling a resized target rebind with fresh bind groups across repeated resizes and no pipeline creates", async () => {
  const gpu = await init();
  const post = effect(gpu, TEXTURE_SHADER, { label: "post" });
  const source = target(gpu, { size: [4, 4] });
  const output = target(gpu, { size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  post.set({ src: source });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: output }, (p) => p.draw(post)));
  const bindGroupsBeforeResize = mock.calls.createBindGroup;
  const pipelinesBeforeResize = mock.calls.createRenderPipeline;
  const asyncPipelinesBeforeResize = mock.calls.createRenderPipelineAsync;

  source.resize([8, 8]);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  frame(gpu, (currentFrame) => currentFrame.pass({ target: output }, (p) => p.draw(post)));
  expect(mock.calls.createBindGroup).toBe(bindGroupsBeforeResize + 1);

  source.resize([16, 16]);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  frame(gpu, (currentFrame) => currentFrame.pass({ target: output }, (p) => p.draw(post)));
  expect(mock.calls.createBindGroup).toBe(bindGroupsBeforeResize + 2);

  post.set({ src: source });
  source.resize([32, 32]);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  frame(gpu, (currentFrame) => currentFrame.pass({ target: output }, (p) => p.draw(post)));
  expect(mock.calls.createBindGroup).toBe(bindGroupsBeforeResize + 3);
  expect(mock.calls.createRenderPipeline).toBe(pipelinesBeforeResize);
  expect(mock.calls.createRenderPipelineAsync).toBe(asyncPipelinesBeforeResize);
  gpu.dispose();
});

test("target recreation subscriptions refresh across repeated resizes and are removed on re-set", async () => {
  const gpu = await init();
  const post = draw(gpu, { shader: TEXTURE_SHADER, label: "post" });
  const sourceA = target(gpu, { size: [4, 4] });
  const sourceB = target(gpu, { size: [4, 4] });
  const sourceC = target(gpu, { size: [4, 4] });
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
  const post = draw(gpu, { shader: TEXTURE_SHADER, label: "post" });
  const sampled = target(gpu, { size: [4, 4] });
  const output = target(gpu, { size: [4, 4] });
  const events: unknown[] = [];

  post.set({ src: sampled });
  registerDrawBundle(post, { id: "bundle", markStale: (event) => { events.push(event); } });
  output.resize([8, 8]);

  expect(events).toEqual([]);
  gpu.dispose();
});

test("set() validates resource kind against reflection before WebGPU bind-group creation", async () => {
  const gpu = await init();
  const lighting = effect(gpu, SAMPLER_SHADER, { label: "lighting" });
  const colorTarget = target(gpu, { size: [4, 4] });

  expect(() => lighting.set({ samp: colorTarget })).toThrowError(/needs sampler/);
  gpu.dispose();
});


test("surface resize reallocates canvas dimensions and notifies on explicit and auto resize", async () => {
  const canvas = mockCanvas(10, 5);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvasSurface = surface(gpu, canvas, { dpr: 2 });
  const seen: readonly [number, number][] = [];
  canvasSurface.onResize(({ width, height }) => { seen.push([width, height]); });

  expect(canvasSurface.size).toEqual([20, 10]);
  canvasSurface.resize([30, 12]);
  expect(canvas.width).toBe(30);
  expect(canvas.height).toBe(12);
  expect(seen).toEqual([[20, 10], [30, 12]]);

  canvas.clientWidth = 20;
  canvas.clientHeight = 10;
  frame(gpu);
  expect(canvasSurface.size).toEqual([40, 20]);
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

/**
 * gpu-first render family: `surface/target/sampler/draw/effect/bundle/frame/frameLoop`.
 *
 * The `gpu.*` methods delegate to exactly these functions, so what is pinned here is the state
 * behind them — one lazy render service per gpu (shared by draw and effect) and one frame runner
 * per gpu (shared by both spellings of a frame).
 */

const FREE_FN_FRAGMENT = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }
`;

test("draw(gpu) and effect(gpu) resolve one lazy render service and share its pipeline cache", async () => {
  const gpu = await init();
  const kernel = kernelOf(gpu);
  // init() builds no cache: the render service appears with the first render factory, not before.
  expect(kernel.peekService(renderServiceToken)).toBeUndefined();

  const scene = target(gpu, { size: [4, 4] });
  const fx = effect(gpu, FREE_FN_FRAGMENT, { label: "fx" });
  const service = kernel.peekService(renderServiceToken);
  expect(service).toBeDefined();

  // Same effective WGSL and same target signature as the effect, created through the other factory.
  const twin = draw(gpu, { shader: fullscreenSource(FREE_FN_FRAGMENT), label: "twin" });
  expect(kernel.peekService(renderServiceToken)).toBe(service);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  frame(gpu, (f) => f.pass(scene, (p) => { p.draw(fx); p.draw(twin); }));
  // One shader module, one layout, one pipeline: a second cache set would have compiled twice.
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.calls.createShaderModule).toBe(1);
  gpu.dispose();
});

test("sampler(gpu, desc) caches by descriptor and dies with the gpu's service phase", async () => {
  const gpu = await init();
  const linear = sampler(gpu, { magFilter: "linear" });
  expect(sampler(gpu, { magFilter: "linear" })).toBe(linear);
  expect(sampler(gpu, { magFilter: "nearest" })).not.toBe(linear);
  // The sampler cache is part of the render service, so asking for one creates it.
  expect(kernelOf(gpu).peekService(renderServiceToken)).toBeDefined();
  gpu.dispose();
});

test("frame(gpu) drives one runner per gpu: the clock advances once per frame and reentrancy is rejected", async () => {
  const gpu = await init();
  const scene = target(gpu, { size: [4, 4] });
  const fx = effect(gpu, FREE_FN_FRAGMENT);

  frame(gpu, (f) => f.pass(scene, fx));
  frame(gpu, (f) => f.pass(scene, fx));
  expect(clock(gpu).frameCount).toBe(2);

  expect(codeOf(() => frame(gpu, () => { frame(gpu, () => undefined); }))).toBe("VGPU-FRAME-REENTRANT");
  expect(codeOf(() => frame(gpu, () => { frame(gpu, () => undefined); }))).toBe("VGPU-FRAME-REENTRANT");
  gpu.dispose();
});

test("frameLoop(gpu, cb) ticks until the gpu is disposed", async () => {
  const gpu = await init();
  let ticks = 0;
  frameLoop(gpu, () => { ticks += 1; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const ran = ticks;
  expect(ran).toBeGreaterThan(0);

  // Loops live in the kernel's scheduler phase: dispose() stops them before the device goes away.
  gpu.dispose();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(ticks).toBe(ran);
});

test("surface(gpu, canvas) is one per canvas and frees the canvas when disposed", async () => {
  const gpu = await init();
  const canvas = mockCanvas(20, 10);
  const first = surface(gpu, canvas);
  expect(codeOf(() => surface(gpu, canvas))).toBe("VGPU-SURFACE-DUPLICATE");

  first.dispose();
  const second = surface(gpu, canvas);
  expect(second).not.toBe(first);
  // Auto-resize still rides the frame clock of this gpu after the swap.
  canvas.clientWidth = 40;
  canvas.clientHeight = 20;
  frame(gpu);
  expect(second.size).toEqual([40, 20]);
  gpu.dispose();
});

test("bundle(gpu, opts, cb) records against the gpu and only recorded bundles replay", async () => {
  const gpu = await init();
  const scene = target(gpu, { size: [4, 4] });
  const tri = draw(gpu, { shader: fullscreenSource(FREE_FN_FRAGMENT), label: "tri" });
  const recorded = bundle(gpu, { target: scene, label: "pass1" }, (r) => r.draw(tri));

  frame(gpu, (f) => f.pass(scene, (p) => p.bundles(recorded)));
  // The nominal bundle protocol replaces the old instanceof check: a look-alike is still rejected.
  expect(codeOf(() => frame(gpu, (f) => f.pass(scene, (p) => p.bundles({ id: "fake", gpu: {} } as never)))))
    .toBe("VGPU-R3-BUNDLE-INVALID");
  gpu.dispose();
});

test("the render factories refuse a disposed gpu instead of handing back a dead handle", async () => {
  const gpu = await init();
  gpu.dispose();
  expect(codeOf(() => draw(gpu, { shader: fullscreenSource(FREE_FN_FRAGMENT) }))).toBe("VGPU-GPU-DISPOSED");
  expect(codeOf(() => effect(gpu, FREE_FN_FRAGMENT))).toBe("VGPU-GPU-DISPOSED");
  expect(codeOf(() => target(gpu, { size: [4, 4] }))).toBe("VGPU-GPU-DISPOSED");
  expect(codeOf(() => sampler(gpu))).toBe("VGPU-GPU-DISPOSED");
  expect(codeOf(() => surface(gpu, mockCanvas(4, 4)))).toBe("VGPU-GPU-DISPOSED");
  expect(codeOf(() => frame(gpu))).toBe("VGPU-GPU-DISPOSED");
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
