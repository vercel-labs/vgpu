import { afterEach, expect, test, vi } from "vitest";
import { createMockGPUDevice, getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init as initBrowser } from "../src/index.ts";
import { init as initNode } from "../src/node.ts";

afterEach(() => vi.unstubAllGlobals());

function externalDevice() {
  const base = createMockGPUDevice();
  const destroy = vi.fn();
  return Object.assign(base, { lost: new Promise<GPUDeviceLostInfo>(() => undefined), destroy });
}

test("browser external init preserves exact identity and bypasses adapter resolution", async () => {
  const device = externalDevice();
  const requestAdapter = vi.fn();
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  const gpu = await initBrowser({ device });
  expect(gpu.gpu).toBe(device);
  expect(gpu.device.gpu).toBe(device);
  expect(requestAdapter).not.toHaveBeenCalled();
  gpu.dispose(); gpu.dispose();
  expect(() => gpu.compute("@compute @workgroup_size(1) fn main() {}" )).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  expect(device.destroy).not.toHaveBeenCalled();
});

test.each(["adapter", "powerPreference", "requiredFeatures", "requiredLimits", "label"])("runtime rejects device combined with %s", async (key) => {
  const options: Record<string, unknown> = { device: externalDevice(), [key]: key === "adapter" ? {} : undefined };
  await expect(initBrowser(options as never)).rejects.toMatchObject({ code: "VGPU-INIT-OPTIONS-CONFLICT" });
});

test("invalid external device shape has stable error code", async () => {
  await expect(initBrowser({ device: {} as GPUDevice })).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
});

test("loss observed during external init rejects without native destruction", async () => {
  const device = Object.assign(createMockGPUDevice(), {
    lost: Promise.resolve({ reason: "destroyed", message: "lost during init" } as GPUDeviceLostInfo),
    destroy: vi.fn(),
  });
  await expect(initBrowser({ device })).rejects.toMatchObject({ code: "VGPU-DEVICE-LOST", message: expect.stringContaining("lost during init") });
  expect(device.destroy).not.toHaveBeenCalled();
});

test("node external init returns null metadata and bypasses native adapter selection", async () => {
  const device = externalDevice();
  const gpu = await initNode({ device });
  expect(gpu.adapter).toBeNull();
  expect(gpu.gpu).toBe(device);
  gpu.dispose();
  expect(device.destroy).not.toHaveBeenCalled();
});

test("disposing a wrapped buffer evicts Ring-1 cache identity and rejects later set", async () => {
  const device = externalDevice();
  const gpu = await initBrowser({ device });
  const raw = device.createBuffer({ size: 16, usage: 128 | 4 | 8 });
  const first = gpu.device.wrapBuffer(raw);
  const compute = gpu.compute(`@group(0) @binding(0) var<storage, read> source: array<u32>; @compute @workgroup_size(1) fn main() { let value = source[0]; }`);
  const instrumentation = getMockGPUDeviceInstrumentation(device);
  compute.set({ source: first }); compute.dispatch(1);
  expect(instrumentation.calls.createBindGroup).toBe(1);
  first.dispose();
  expect(() => compute.set({ source: first })).toThrow(expect.objectContaining({ code: "VGPU-BUFFER-DISPOSED" }));
  const second = gpu.device.wrapBuffer(raw);
  compute.set({ source: second }); compute.dispatch(1);
  expect(instrumentation.calls.createBindGroup).toBe(2);
  second.dispose(); gpu.dispose();
});

test("retained compute and uniform-like bindings respect logical disposal", async () => {
  const device = externalDevice();
  const gpu = await initBrowser({ device });
  const dispatch = gpu.compute("@compute @workgroup_size(1) fn main() {}");
  const raw = device.createBuffer({ size: 16, usage: 64 | 8 });
  const wrapped = gpu.device.wrapBuffer(raw);
  const uniformLike = { gpu: wrapped.gpu, size: 16, buffer: wrapped };
  const set = gpu.compute("struct U { value: u32 }; @group(0) @binding(0) var<uniform> u: U; @compute @workgroup_size(1) fn main() { let x = u.value; }");
  wrapped.dispose();
  expect(() => set.set({ u: uniformLike })).toThrow(expect.objectContaining({ code: "VGPU-BUFFER-DISPOSED" }));
  gpu.dispose();
  expect(() => dispatch.dispatch(1)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
});

test("retained draw, effect, and frame operations respect logical disposal", async () => {
  const gpu = await initBrowser({ device: externalDevice() });
  const effect = gpu.effect("@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }");
  const draw = gpu.draw({ shader: "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i), 0, 0, 1); } @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }" });
  const frame = gpu.frame();
  gpu.dispose();
  expect(() => effect.set({})).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  expect(() => draw.set({})).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  expect(() => frame.submit()).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
});

test("retained compute reports device loss reason", async () => {
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  const device = Object.assign(createMockGPUDevice(), { lost: new Promise<GPUDeviceLostInfo>((resolve) => { resolveLost = resolve; }), destroy: vi.fn() });
  const gpu = await initBrowser({ device });
  const compute = gpu.compute("@compute @workgroup_size(1) fn main() {}");
  resolveLost({ reason: "unknown", message: "runtime lost" } as GPUDeviceLostInfo);
  await Promise.resolve();
  expect(() => compute.dispatch(1)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST", message: expect.stringContaining("runtime lost") }));
  gpu.dispose();
});

test("hostile plain-JS init options use stable validation codes", async () => {
  await expect(initBrowser(null as never)).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
  const throwingDevice = Object.defineProperty({}, "device", { get() { throw new Error("getter boom"); } });
  await expect(initBrowser(throwingDevice as never)).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
});

test("exclusive InitOptions rejects mixed forms at compile time", () => {
  // @ts-expect-error external device cannot be combined with a label
  const invalid: Parameters<typeof initBrowser>[0] = { device: externalDevice(), label: "mixed" };
  expect(invalid).toBeDefined();
});
