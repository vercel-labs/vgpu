import { afterEach, expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init } from "../src/mock.ts";
import { InternalDraw } from "../src/draw.ts";
import { createPipelineStore, createShaderModuleCache, signatureKeyOf } from "../src/pipeline-store.ts";

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
  const target = gpu.target({ size: [2, 2] });
  const a = gpu.draw({ shader: WGSL, label: "dedupe-a" });
  const b = gpu.draw({ shader: WGSL, label: "dedupe-b" });

  await a.draw(target);
  await b.draw(target);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // Baseline before Task 02 was 2; shared device-level pipeline store should reduce this to 1.
  expect(mock.calls.createRenderPipeline).toBe(1);
  gpu.dispose();
});

test("different vertex buffer layouts do not collide", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const a = gpu.draw({ shader: VERTEX_WGSL, label: "layout-a", mesh: { vertexBufferLayouts: [VERTEX_LAYOUT_A] } });
  const b = gpu.draw({ shader: VERTEX_WGSL, label: "layout-b", mesh: { vertexBufferLayouts: [VERTEX_LAYOUT_B] } });

  await a.draw(target);
  await b.draw(target);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(2);
  gpu.dispose();
});

test("dynamic layout swap changes the pipeline key without clearing the store", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const draw = gpu.draw({ shader: GROUP_WGSL, label: "dynamic-layout" }) as InternalDraw;

  draw.pipelineFor(target);
  draw.layout(0, { dynamicOffsets: true });
  draw.pipelineFor(target);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(2);
  gpu.dispose();
});

test("sync pipeline creation wins a pending async create and suppresses late native rejection", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const store = createPipelineStore(gpu.device);
  const modules = createShaderModuleCache(gpu.device);
  const draw = new InternalDraw(gpu.device, WGSL, { shader: WGSL, label: "sync-wins" }, undefined, undefined, store, modules);
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
    const pending = draw.pipelineForAsync(target);
    const syncPipeline = draw.pipelineFor(target);
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
  const target = gpu.target({ size: [2, 2] });
  const store = createPipelineStore(gpu.device);
  const modules = createShaderModuleCache(gpu.device);
  const draw = new InternalDraw(gpu.device, WGSL, { shader: WGSL, label: "dispose-pending" }, undefined, undefined, store, modules);
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockImplementation(() => new Promise<GPURenderPipeline>(() => undefined));

  const pending = draw.pipelineForAsync(target);
  store.dispose();

  await expect(pending).rejects.toMatchObject({ code: "VGPU-COMPILE-DISPOSED" });
  modules.dispose();
  gpu.dispose();
});

test("signatureKeyOf matches the pre-store draw key", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2], format: "rgba8unorm", depth: "depth24plus", msaa: true });
  expect(signatureKeyOf({ colors: target.colors.map((color) => color.format), depth: target.depth?.format, sampleCount: target.sampleCount }))
    .toBe(`${target.colors.map((color) => color.format).join(",")}:${target.depth?.format ?? "none"}:${target.sampleCount}`);
  gpu.dispose();
});
