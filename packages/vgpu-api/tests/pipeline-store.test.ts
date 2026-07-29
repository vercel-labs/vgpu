import { afterEach, expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { createMockAdapter, init, draw, target } from "../src/mock.ts";
import { InternalDraw } from "../src/draw.ts";
import { createPipelineStore, createShaderModuleCache, pipelineKeyOf, signatureKeyOf } from "../src/pipeline-store.ts";

const WGSL = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const VERTEX_WGSL = `
@vertex fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return vec4f(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const GROUP_WGSL = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0 + params.value * 0.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const VERTEX_LAYOUT_A: GPUVertexBufferLayout = {
  arrayStride: 12,
  attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
};

const VERTEX_LAYOUT_B: GPUVertexBufferLayout = {
  arrayStride: 16,
  attributes: [{ shaderLocation: 0, offset: 4, format: "float32x3" }],
};

afterEach(() => vi.restoreAllMocks());

test("device store dedupes byte-identical WGSL, layout, and signature across draws", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const a = draw(gpu, { shader: WGSL, label: "dedupe-a" });
  const b = draw(gpu, { shader: WGSL, label: "dedupe-b" });

  a.draw(colorTarget);
  b.draw(colorTarget);
  await gpu.settled();

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // Baseline before Task 02 was 2; shared device-level pipeline store should reduce this to 1.
  expect(mock.calls.createRenderPipeline).toBe(1);
  gpu.dispose();
});

test("different vertex buffer layouts do not collide", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const a = draw(gpu, { shader: VERTEX_WGSL, label: "layout-a", geometry: { vertexBufferLayouts: [VERTEX_LAYOUT_A] } });
  const b = draw(gpu, { shader: VERTEX_WGSL, label: "layout-b", geometry: { vertexBufferLayouts: [VERTEX_LAYOUT_B] } });

  a.draw(colorTarget);
  b.draw(colorTarget);
  await gpu.settled();

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(2);
  gpu.dispose();
});

test("dynamic layout swap changes the pipeline key without clearing the store", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const drawable = draw(gpu, { shader: GROUP_WGSL, label: "dynamic-layout" }) as InternalDraw;

  drawable.pipelineFor(colorTarget);
  drawable.layout(0, { dynamicOffsets: true });
  drawable.pipelineFor(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(2);
  gpu.dispose();
});

test("blend and writeMask participate in shared pipeline cache keys", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const a = draw(gpu, { shader: WGSL, label: "blend-a", blend: "alpha" });
  const b = draw(gpu, { shader: WGSL, label: "blend-b", blend: "additive" });
  const c = draw(gpu, { shader: WGSL, label: "blend-c", blend: "alpha" });
  const mask = draw(gpu, { shader: WGSL, label: "mask", writeMask: ["r", "g", "b"] });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  mask.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(3);
  gpu.dispose();
});

test("strip geometries that derive stripIndexFormat from indexFormat do not collide in the cache", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  // Neither geometry spells stripIndexFormat out: the descriptor derives it from indexFormat, so the key must too.
  const a = draw(gpu, { shader: WGSL, label: "strip-uint16", geometry: { topology: "triangle-strip", indexFormat: "uint16" } });
  const b = draw(gpu, { shader: WGSL, label: "strip-uint32", geometry: { topology: "triangle-strip", indexFormat: "uint32" } });
  const c = draw(gpu, { shader: WGSL, label: "strip-uint16-again", geometry: { topology: "triangle-strip", indexFormat: "uint16" } });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(2);
  expect(mock.createRenderPipelineDescriptors.at(-2)?.primitive).toMatchObject({ topology: "triangle-strip", stripIndexFormat: "uint16" });
  expect(mock.createRenderPipelineDescriptors.at(-1)?.primitive).toMatchObject({ topology: "triangle-strip", stripIndexFormat: "uint32" });
  gpu.dispose();
});

test("an explicit stripIndexFormat and the derived one share a pipeline", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const derived = draw(gpu, { shader: WGSL, label: "derived", geometry: { topology: "line-strip", indexFormat: "uint16" } });
  const explicitFormat = draw(gpu, { shader: WGSL, label: "explicit", geometry: { topology: "line-strip", stripIndexFormat: "uint16", indexFormat: "uint16" } });

  derived.draw(colorTarget);
  explicitFormat.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(1);
  gpu.dispose();
});

test("cull and frontFace participate in shared pipeline cache keys", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const a = draw(gpu, { shader: WGSL, label: "cull-a", cull: "back" });
  const b = draw(gpu, { shader: WGSL, label: "cull-b", cull: "front" });
  const c = draw(gpu, { shader: WGSL, label: "cull-c", cull: "back" });
  const face = draw(gpu, { shader: WGSL, label: "face", cull: "back", frontFace: "cw" });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  face.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(3);
  gpu.dispose();
});

test("depth participates in shared pipeline cache keys", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  const a = draw(gpu, { shader: WGSL, label: "depth-a", depth: { compare: "greater" } });
  const b = draw(gpu, { shader: WGSL, label: "depth-b", depth: false });
  const c = draw(gpu, { shader: WGSL, label: "depth-c", depth: { compare: "greater" } });
  const d = draw(gpu, { shader: WGSL, label: "depth-d", depth: { compare: "greater", write: false } });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  d.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(3);
  gpu.dispose();
});

test("stencil participates in shared pipeline cache keys; ref stays out", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  const a = draw(gpu, { shader: WGSL, label: "st-a", stencil: { front: { compare: "equal", pass: "replace" } } });
  const b = draw(gpu, { shader: WGSL, label: "st-b", stencil: { front: { compare: "equal", pass: "replace" }, writeMask: 0xFF } });
  const c = draw(gpu, { shader: WGSL, label: "st-c", stencil: { front: { compare: "equal", pass: "replace" } } });
  const refOnlyDiff = draw(gpu, { shader: WGSL, label: "st-ref", stencil: { front: { compare: "equal", pass: "replace" }, ref: 7 } });
  const plain = draw(gpu, { shader: WGSL, label: "st-plain" });
  const empty = draw(gpu, { shader: WGSL, label: "st-empty", stencil: {} });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  refOnlyDiff.draw(colorTarget);
  plain.draw(colorTarget);
  empty.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // a/c share, ref-only difference shares with them, b is distinct, plain is distinct, and an all-defaults {} shares the plain key.
  expect(mock.calls.createRenderPipeline).toBe(3);
  gpu.dispose();
});

test("multisample participates in shared pipeline cache keys", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], msaa: true });
  const a = draw(gpu, { shader: WGSL, label: "ms-a", multisample: { alphaToCoverage: true } });
  const b = draw(gpu, { shader: WGSL, label: "ms-b", multisample: { mask: 0b0101 } });
  const c = draw(gpu, { shader: WGSL, label: "ms-c", multisample: { alphaToCoverage: true } });
  const plain = draw(gpu, { shader: WGSL, label: "ms-plain" });
  const empty = draw(gpu, { shader: WGSL, label: "ms-empty", multisample: {} });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  plain.draw(colorTarget);
  empty.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // a/c share, b is distinct, plain is distinct, and an all-defaults {} shares the plain key.
  expect(mock.calls.createRenderPipeline).toBe(3);
  gpu.dispose();
});

test("unclippedDepth participates in shared pipeline cache keys", async () => {
  const gpu = await init({ adapter: createMockAdapter({ features: ["depth-clip-control"] }), requiredFeatures: ["depth-clip-control"] });
  const colorTarget = target(gpu, { size: [2, 2] });
  const a = draw(gpu, { shader: WGSL, label: "unclipped-a", unclippedDepth: true });
  const b = draw(gpu, { shader: WGSL, label: "unclipped-b" });
  const c = draw(gpu, { shader: WGSL, label: "unclipped-c", unclippedDepth: true });
  const explicitFalse = draw(gpu, { shader: WGSL, label: "unclipped-false", unclippedDepth: false });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  explicitFalse.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // a/c share, plain is distinct, and an explicit false shares the plain key.
  expect(mock.calls.createRenderPipeline).toBe(2);
  gpu.dispose();
});

test("constants participate in shared pipeline cache keys", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const OVERRIDE_WGSL = `
override SCALE: f32 = 1.0;
${WGSL}`;
  const a = draw(gpu, { shader: OVERRIDE_WGSL, label: "cn-a", constants: { SCALE: 2 } });
  const b = draw(gpu, { shader: OVERRIDE_WGSL, label: "cn-b", constants: { SCALE: 3 } });
  const c = draw(gpu, { shader: OVERRIDE_WGSL, label: "cn-c", constants: { SCALE: 2 } });
  const plain = draw(gpu, { shader: OVERRIDE_WGSL, label: "cn-plain" });
  const empty = draw(gpu, { shader: OVERRIDE_WGSL, label: "cn-empty", constants: {} });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  plain.draw(colorTarget);
  empty.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // a/c share, b is distinct, plain is distinct, and an empty {} shares the plain key.
  expect(mock.calls.createRenderPipeline).toBe(3);
  gpu.dispose();
});

test("entry points participate in shared pipeline cache keys", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const TWO_FRAGMENT_WGSL = `${WGSL}
@fragment fn fs_alt() -> @location(0) vec4f { return vec4f(0.5); }`;
  const a = draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "en-a", entry: { fragment: "fs_alt" } });
  const b = draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "en-b", entry: { fragment: "fs_alt" } });
  const plain = draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "en-plain" });
  const explicitDefaults = draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "en-defaults", entry: { vertex: "vs_main", fragment: "fs_main" } });

  a.draw(colorTarget);
  b.draw(colorTarget);
  plain.draw(colorTarget);
  explicitDefaults.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // a/b share, plain is distinct, and explicitly naming the first-of-stage entries shares the plain key.
  expect(mock.calls.createRenderPipeline).toBe(2);
  gpu.dispose();
});

test("pipelineKeyOf appends fragmentKey only when present", () => {
  const module = {} as GPUShaderModule;
  const pipelineLayout = {} as GPUPipelineLayout;
  const parts = { module, pipelineLayout, signature: { colors: ["rgba8unorm"] as const } };
  const base = pipelineKeyOf(parts);

  expect(pipelineKeyOf({ ...parts, fragmentKey: undefined })).toBe(base);
  expect(pipelineKeyOf({ ...parts, fragmentKey: "none;none;7" })).toBe(`${base}|none;none;7`);
  expect(pipelineKeyOf({ ...parts, constantsKey: "cn~SCALE=2" })).toBe(`${base}|cn~SCALE=2`);
  expect(pipelineKeyOf({ ...parts, entryKey: "en~vs_main~fs_alt" })).toBe(`${base}|en~vs_main~fs_alt`);
});

test("sync pipeline creation wins a pending async create and suppresses late native rejection", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const store = createPipelineStore(gpu.device);
  const modules = createShaderModuleCache(gpu.device);
  const drawable = new InternalDraw(gpu.device, WGSL, { shader: WGSL, label: "sync-wins" }, undefined, undefined, store, modules);
  const lateNativeError = new Error("late native compile failed");
  let rejectNative!: (error: unknown) => void;
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockImplementation((desc: GPURenderPipelineDescriptor) => {
    getMockGPUDeviceInstrumentation(gpu.device.gpu).calls.createRenderPipelineAsync += 1;
    getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineAsyncDescriptors.push(desc);
    return new Promise<GPURenderPipeline>((_resolve, reject) => { rejectNative = reject; });
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);

  try {
    const pending = drawable.pipelineForAsync(colorTarget);
    const syncPipeline = drawable.pipelineFor(colorTarget);
    await expect(pending).resolves.toBe(syncPipeline);
    rejectNative(lateNativeError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(mock.calls.createRenderPipelineAsync).toBe(1);
    expect(mock.calls.createRenderPipeline).toBe(1);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    store.dispose();
    modules.dispose();
    gpu.dispose();
  }
});

test("disposing the store rejects pending async compiles with VGPU-COMPILE-DISPOSED", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const store = createPipelineStore(gpu.device);
  const modules = createShaderModuleCache(gpu.device);
  const drawable = new InternalDraw(gpu.device, WGSL, { shader: WGSL, label: "dispose-pending" }, undefined, undefined, store, modules);
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockImplementation(() => new Promise<GPURenderPipeline>(() => undefined));

  const pending = drawable.pipelineForAsync(colorTarget);
  store.dispose();

  await expect(pending).rejects.toMatchObject({ code: "VGPU-COMPILE-DISPOSED" });
  modules.dispose();
  gpu.dispose();
});

test("signatureKeyOf matches the pre-store draw key", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], format: "rgba8unorm", depth: "depth24plus", msaa: true });
  expect(signatureKeyOf({ colors: colorTarget.colors.map((color) => color.format), depth: colorTarget.depth?.format, sampleCount: colorTarget.sampleCount }))
    .toBe(`${colorTarget.colors.map((color) => color.format).join(",")}:${colorTarget.depth?.format ?? "none"}:${colorTarget.sampleCount}`);
  gpu.dispose();
});
