import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init } from "../src/mock.ts";

const WGSL = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const FRAGMENT_ONLY = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

test("Draw.compile warms the shared store so later draw does not sync-create", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const draw = gpu.draw({ shader: WGSL, label: "warm" });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  await expect(draw.compile(target)).resolves.toBe(draw);
  expect(draw.gpu).toBeDefined();
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);

  draw.draw(target);
  await gpu.settled();
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  gpu.dispose();
});

test("concurrent Draw.compile calls for the same signature share one async native create", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const draw = gpu.draw({ shader: WGSL, label: "fanout" });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  const [a, b, c] = await Promise.all([draw.compile(target), draw.compile(target), draw.compile(target)]);

  expect(a).toBe(draw);
  expect(b).toBe(draw);
  expect(c).toBe(draw);
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  gpu.dispose();
});

test("Draw.compile rejection is owned by the returned promise and not mirrored to gpu.onError", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const draw = gpu.draw({ shader: WGSL, label: "rejectOwned" });
  const nativeError = new Error("async pipeline failed");
  const errors: unknown[] = [];
  gpu.onError((error) => errors.push(error));
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockRejectedValue(nativeError);

  await expect(draw.compile(target)).rejects.toMatchObject({
    code: "VGPU-COMPILE-FAILED",
    where: "rejectOwned.compile",
    cause: nativeError,
    detail: { signature: "rgba8unorm:none:1" },
  });
  await gpu.settled();

  expect(errors).toEqual([]);
  gpu.dispose();
});

test("Draw.compileSync wins an in-flight Draw.compile and resolves the pending public promise", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const draw = gpu.draw({ shader: WGSL, label: "publicSyncWins" });
  let rejectNative!: (error: unknown) => void;
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockImplementation((desc: GPURenderPipelineDescriptor) => {
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    mock.calls.createRenderPipelineAsync += 1;
    mock.createRenderPipelineAsyncDescriptors.push(desc);
    return new Promise<GPURenderPipeline>((_resolve, reject) => { rejectNative = reject; });
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);

  try {
    const pending = draw.compile(target);
    expect(draw.compileSync(target)).toBe(draw);
    await expect(pending).resolves.toBe(draw);
    const syncPipeline = draw.gpu;
    expect(syncPipeline).toBeDefined();

    rejectNative(new Error("late async failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(mock.calls.createRenderPipelineAsync).toBe(1);
    expect(mock.calls.createRenderPipeline).toBe(1);
    expect(draw.gpu).toBe(syncPipeline);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gpu.dispose();
  }
});

test("compile validates signatures and missing default targets synchronously", async () => {
  const gpu = await init();
  const draw = gpu.draw({ shader: WGSL, label: "invalid" });

  expect(() => draw.compile()).toThrowError(/VGPU-TARGET-REQUIRED|target explícito/);
  expect(() => draw.compileSync()).toThrowError(/VGPU-TARGET-REQUIRED|target explícito/);
  expect(() => draw.compile({ colors: [] })).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|colors/);
  expect(() => draw.compileSync({ colors: ["rgba8unorm"], sampleCount: 2 as never })).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|sampleCount/);
  expect(() => draw.compileSync({ colors: ["rgba8unorm"], depth: { format: "depth24plus" } as never })).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|depth/);
  expect(() => draw.compile({ colors: "rgba8unorm" } as never)).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|colors/);
  expect(() => draw.compile("rgba8unorm" as never)).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|colors/);
  gpu.dispose();
});

test("Effect compile delegates to Draw, fixes gpu getter, and shares the device store", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const effect = gpu.effect(WGSL, { label: "fx" });
  const draw = gpu.draw({ shader: WGSL, label: "drawFx" });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  expect(effect.gpu).toBeUndefined();
  await expect(effect.compile(target)).resolves.toBe(effect);
  expect(effect.gpu).toBeDefined();
  await draw.compile(target);

  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  gpu.dispose();
});

test("gpu.settled drains in-flight async compiles", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const draw = gpu.draw({ shader: WGSL, label: "settledCompile" });
  let resolveNative!: (pipeline: GPURenderPipeline) => void;
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockImplementation((desc: GPURenderPipelineDescriptor) => {
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    mock.calls.createRenderPipelineAsync += 1;
    mock.createRenderPipelineAsyncDescriptors.push(desc);
    return new Promise<GPURenderPipeline>((resolve) => { resolveNative = resolve; });
  });

  const pending = draw.compile(target);
  let settled = false;
  const drained = gpu.settled().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);

  resolveNative({} as GPURenderPipeline);
  await drained;
  await expect(pending).resolves.toBe(draw);
  expect(settled).toBe(true);
  gpu.dispose();
});

test("DrawOptions.targets remains compileSync creation sugar", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  const draw = gpu.draw({ shader: WGSL, label: "targetsSugar", targets: [target] });
  expect(draw.gpu).toBeDefined();
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(0);

  draw.draw(target);
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(0);
  gpu.dispose();
});
