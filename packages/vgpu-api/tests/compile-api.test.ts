import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, bundle, draw, effect, frame, surface, target } from "../src/mock.ts";

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

function surfaceCanvas(): HTMLCanvasElement {
  const canvas: Record<string, unknown> = { width: 4, height: 4 };
  canvas.getContext = (kind: string) => kind === "webgpu" ? {
    configure: () => undefined,
    getCurrentTexture: () => ({ createView: () => ({}) }),
  } : null;
  return canvas as HTMLCanvasElement;
}

function expectOutsideFrame(fn: () => unknown): void {
  try { fn(); }
  catch (error) {
    expect(error).toMatchObject({
      code: "VGPU-SURFACE-NOT-IN-FRAME",
      fix: "surface passes must run inside frame(gpu, ...); precompile against an offscreen target(gpu, ...) instead",
    });
    return;
  }
  throw new Error("Expected VGPU-SURFACE-NOT-IN-FRAME");
}

test("surface pipeline creation is rejected outside frame(gpu) with an offscreen precompile hint", async () => {
  const gpu = await init();
  const canvasSurface = surface(gpu, surfaceCanvas());
  const drawable = draw(gpu, { shader: WGSL });
  const shader1 = effect(gpu, FRAGMENT_ONLY);

  expectOutsideFrame(() => drawable.compile(canvasSurface));
  expectOutsideFrame(() => drawable.compileSync(canvasSurface));
  expectOutsideFrame(() => drawable.draw(canvasSurface));
  expectOutsideFrame(() => shader1.compile(canvasSurface));
  expectOutsideFrame(() => shader1.compileSync(canvasSurface));
  expectOutsideFrame(() => shader1.draw(canvasSurface));
  expectOutsideFrame(() => bundle(gpu, { target: canvasSurface }, () => undefined));
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass(canvasSurface, drawable))).not.toThrow();
  gpu.dispose();
});

test("Draw.compile warms the shared store so later draw does not sync-create", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: WGSL, label: "warm" });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  await expect(drawable.compile(colorTarget)).resolves.toBe(drawable);
  expect(drawable.gpu).toBeDefined();
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);

  drawable.draw(colorTarget);
  await gpu.settled();
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  gpu.dispose();
});

test("concurrent Draw.compile calls for the same signature share one async native create", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: WGSL, label: "fanout" });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  const [a, b, c] = await Promise.all([drawable.compile(colorTarget), drawable.compile(colorTarget), drawable.compile(colorTarget)]);

  expect(a).toBe(drawable);
  expect(b).toBe(drawable);
  expect(c).toBe(drawable);
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  gpu.dispose();
});

test("Draw.compile rejection is owned by the returned promise and not mirrored to gpu.onError", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: WGSL, label: "rejectOwned" });
  const nativeError = new Error("async pipeline failed");
  const errors: unknown[] = [];
  gpu.onError((error) => errors.push(error));
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockRejectedValue(nativeError);

  await expect(drawable.compile(colorTarget)).rejects.toMatchObject({
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
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: WGSL, label: "publicSyncWins" });
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
    const pending = drawable.compile(colorTarget);
    expect(drawable.compileSync(colorTarget)).toBe(drawable);
    await expect(pending).resolves.toBe(drawable);
    const syncPipeline = drawable.gpu;
    expect(syncPipeline).toBeDefined();

    rejectNative(new Error("late async failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(mock.calls.createRenderPipelineAsync).toBe(1);
    expect(mock.calls.createRenderPipeline).toBe(1);
    expect(drawable.gpu).toBe(syncPipeline);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gpu.dispose();
  }
});

test("compile validates signatures and missing default targets synchronously", async () => {
  const gpu = await init();
  const drawable = draw(gpu, { shader: WGSL, label: "invalid" });

  expect(() => drawable.compile()).toThrowError(/VGPU-TARGET-REQUIRED|Target required/);
  expect(() => drawable.compileSync()).toThrowError(/VGPU-TARGET-REQUIRED|Target required/);
  expect(() => drawable.compile({ colors: [] })).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|colors/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"], sampleCount: 2 as never })).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|sampleCount/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"], depth: { format: "depth24plus" } as never })).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|depth/);
  expect(() => drawable.compile({ colors: "rgba8unorm" } as never)).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|colors/);
  expect(() => drawable.compile("rgba8unorm" as never)).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|colors/);
  gpu.dispose();
});

test("Effect compile delegates to Draw, fixes gpu getter, and shares the device store", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const shader1 = effect(gpu, WGSL, { label: "fx" });
  const drawable = draw(gpu, { shader: WGSL, label: "drawFx" });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  expect(shader1.gpu).toBeUndefined();
  await expect(shader1.compile(colorTarget)).resolves.toBe(shader1);
  expect(shader1.gpu).toBeDefined();
  await drawable.compile(colorTarget);

  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  gpu.dispose();
});

test("gpu.settled drains in-flight async compiles", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: WGSL, label: "settledCompile" });
  let resolveNative!: (pipeline: GPURenderPipeline) => void;
  vi.spyOn(gpu.device.gpu, "createRenderPipelineAsync").mockImplementation((desc: GPURenderPipelineDescriptor) => {
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    mock.calls.createRenderPipelineAsync += 1;
    mock.createRenderPipelineAsyncDescriptors.push(desc);
    return new Promise<GPURenderPipeline>((resolve) => { resolveNative = resolve; });
  });

  const pending = drawable.compile(colorTarget);
  let settled = false;
  const drained = gpu.settled().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);

  resolveNative({} as GPURenderPipeline);
  await drained;
  await expect(pending).resolves.toBe(drawable);
  expect(settled).toBe(true);
  gpu.dispose();
});

test("DrawOptions.targets remains compileSync creation sugar", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  const drawable = draw(gpu, { shader: WGSL, label: "targetsSugar", targets: [colorTarget] });
  expect(drawable.gpu).toBeDefined();
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(0);

  drawable.draw(colorTarget);
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(0);
  gpu.dispose();
});
