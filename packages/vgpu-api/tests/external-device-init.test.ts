import { afterEach, expect, test, vi } from "vitest";
import { createMockGPUDevice, getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { clock, compute, draw, effect, frame, init as initBrowser, initFromDevice, uniforms } from "../src/index.ts";
import { initFromDevice as initFromDeviceNode } from "../src/node.ts";

afterEach(() => vi.unstubAllGlobals());

function externalDevice() {
  const base = createMockGPUDevice();
  const destroy = vi.fn();
  return Object.assign(base, { lost: new Promise<GPUDeviceLostInfo>(() => undefined), destroy });
}

/** Resolves the device's `lost` promise on demand, standing in for the owner killing it. */
function losableDevice() {
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  const device = Object.assign(createMockGPUDevice(), {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => { resolveLost = resolve; }),
    destroy: vi.fn(),
  });
  return { device, lose: (info: Partial<GPUDeviceLostInfo>) => resolveLost(info as GPUDeviceLostInfo) };
}

test("browser external init preserves exact identity and bypasses adapter resolution", async () => {
  const device = externalDevice();
  const requestAdapter = vi.fn();
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  const gpu = await initFromDevice(device);
  expect(gpu.gpu).toBe(device);
  expect(gpu.device.gpu).toBe(device);
  expect(requestAdapter).not.toHaveBeenCalled();
  gpu.dispose(); gpu.dispose();
  // A factory is refused at the kernel boundary: the gpu, not the device, is what went away.
  expect(() => compute(gpu, "@compute @workgroup_size(1) fn main() {}")).toThrow(expect.objectContaining({ code: "VGPU-GPU-DISPOSED" }));
  expect(device.destroy).not.toHaveBeenCalled();
});

test("init() does not adopt a device: that is initFromDevice's job", async () => {
  const device = externalDevice();
  const requestAdapter = vi.fn(async () => null);
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  // There is deliberately no runtime guard — one does not fit the init-only budget this split
  // exists to protect. `device` is typed `never`, so this is a compile error; at runtime init()
  // just requests its own device and never looks at the field.
  // @ts-expect-error device is not an init() option: call initFromDevice(device)
  await expect(initBrowser({ device })).rejects.toBeDefined();
  expect(requestAdapter).toHaveBeenCalled();
  expect(device.destroy).not.toHaveBeenCalled();
});

test("invalid external device shape has stable error code", async () => {
  await expect(initFromDevice({} as GPUDevice)).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
});

test("loss observed during external init rejects without native destruction", async () => {
  const device = Object.assign(createMockGPUDevice(), {
    lost: Promise.resolve({ reason: "destroyed", message: "lost during init" } as GPUDeviceLostInfo),
    destroy: vi.fn(),
  });
  await expect(initFromDevice(device)).rejects.toMatchObject({ code: "VGPU-DEVICE-LOST", message: expect.stringContaining("lost during init") });
  expect(device.destroy).not.toHaveBeenCalled();
});

test("the node entry adopts through the same function and exposes no adapter", async () => {
  const device = externalDevice();
  const gpu = await initFromDeviceNode(device);
  expect(gpu.gpu).toBe(device);
  // `NodeGpu.adapter` belongs to init(), which selects a Dawn adapter. There is none to describe
  // here, so adoption returns the plain `Gpu` rather than a NodeGpu with a null field.
  expect("adapter" in gpu).toBe(false);
  gpu.dispose();
  expect(device.destroy).not.toHaveBeenCalled();
});

test("disposing a wrapped buffer evicts Ring-1 cache identity and rejects later set", async () => {
  const device = externalDevice();
  const gpu = await initFromDevice(device);
  const raw = device.createBuffer({ size: 16, usage: 128 | 4 | 8 });
  const first = gpu.device.wrapBuffer(raw);
  const pipeline = compute(gpu, `@group(0) @binding(0) var<storage, read> source: array<u32>; @compute @workgroup_size(1) fn main() { let value = source[0]; }`);
  const instrumentation = getMockGPUDeviceInstrumentation(device);
  pipeline.set({ source: first }); pipeline.dispatch(1);
  expect(instrumentation.calls.createBindGroup).toBe(1);
  first.dispose();
  expect(() => pipeline.set({ source: first })).toThrow(expect.objectContaining({ code: "VGPU-BUFFER-DISPOSED" }));
  const second = gpu.device.wrapBuffer(raw);
  pipeline.set({ source: second }); pipeline.dispatch(1);
  expect(instrumentation.calls.createBindGroup).toBe(2);
  second.dispose(); gpu.dispose();
});

test("retained compute and uniform-like bindings respect logical disposal", async () => {
  const device = externalDevice();
  const gpu = await initFromDevice(device);
  const dispatch = compute(gpu, "@compute @workgroup_size(1) fn main() {}");
  const raw = device.createBuffer({ size: 16, usage: 64 | 8 });
  const wrapped = gpu.device.wrapBuffer(raw);
  const uniformLike = { gpu: wrapped.gpu, size: 16, buffer: wrapped };
  const set = compute(gpu, "struct U { value: u32 }; @group(0) @binding(0) var<uniform> u: U; @compute @workgroup_size(1) fn main() { let x = u.value; }");
  wrapped.dispose();
  expect(() => set.set({ u: uniformLike })).toThrow(expect.objectContaining({ code: "VGPU-BUFFER-DISPOSED" }));
  gpu.dispose();
  // Retained object, already built: our own guard reports the device it can no longer reach.
  expect(() => dispatch.dispatch(1)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
});

test("retained draw and effect operations respect logical disposal", async () => {
  const gpu = await initFromDevice(externalDevice());
  const fullscreen = effect(gpu, "@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }");
  const triangle = draw(gpu, { shader: "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i), 0, 0, 1); } @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }" });
  gpu.dispose();
  expect(() => fullscreen.set({})).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  expect(() => triangle.set({})).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
});

test("an explicit submit still reports a device the owner killed", async () => {
  // `gpu.dispose()` cancels outstanding frames, so a submit after it is deliberately a no-op. The
  // case this guards is different: the gpu is still alive and the *owner* took the device away.
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  const pending = frame(gpu);
  lose({ reason: "destroyed", message: "owner destroyed it" });
  await Promise.resolve();
  expect(() => pending.submit()).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
  gpu.dispose();
});

test("retained compute reports device loss reason", async () => {
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  const pipeline = compute(gpu, "@compute @workgroup_size(1) fn main() {}");
  lose({ reason: "unknown", message: "runtime lost" });
  await Promise.resolve();
  expect(() => pipeline.dispatch(1)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST", message: expect.stringContaining("runtime lost") }));
  gpu.dispose();
});

test("hostile plain-JS devices use stable validation codes", async () => {
  for (const bad of [null, undefined, 42, "device", {}, { queue: {} }]) {
    await expect(initFromDevice(bad as never)).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
  }
});

test("shared uniforms reject a disposed backing buffer", async () => {
  const gpu = await initFromDevice(externalDevice());
  const shared = uniforms(gpu, { value: 1 });
  const pipeline = compute(gpu, "struct U { value: f32 }; @group(0) @binding(0) var<uniform> u: U; @compute @workgroup_size(1) fn main() { let x = u.value; }");
  pipeline.set({ u: shared });
  const buffer = (shared as unknown as { buffer: import("@vgpu/core").Buffer }).buffer;
  buffer.dispose();
  expect(() => pipeline.set({ u: shared })).toThrow(expect.objectContaining({ code: "VGPU-BUFFER-DISPOSED" }));
  gpu.dispose();
});

test("frame state rejects reads and advances after loss", async () => {
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  lose({ reason: "destroyed", message: "state lost" });
  await Promise.resolve(); await Promise.resolve();
  // `clock(gpu)` is the frame-state entry point since 0.2.0; it must refuse a device that is gone.
  expect(() => clock(gpu).time).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
  expect(() => clock(gpu).advance(1)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
});

test("init() rejects a device at compile time", () => {
  // @ts-expect-error adoption is initFromDevice(device), never an init() option
  const invalid: Parameters<typeof initBrowser>[0] = { device: externalDevice() };
  expect(invalid).toBeDefined();
});
