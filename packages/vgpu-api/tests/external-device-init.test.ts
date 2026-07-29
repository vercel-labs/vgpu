import { afterEach, expect, test, vi } from "vitest";
import { createMockGPUDevice, Device, getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { clock, compute, draw, effect, frame, init as initBrowser, uniforms } from "../src/index.ts";
import { init as initNode } from "../src/node.ts";

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
  const gpu = await initBrowser({ device });
  expect(gpu.gpu).toBe(device);
  expect(gpu.device.gpu).toBe(device);
  expect(requestAdapter).not.toHaveBeenCalled();
  gpu.dispose(); gpu.dispose();
  // A factory is refused at the kernel boundary: the gpu, not the device, is what went away.
  expect(() => compute(gpu, "@compute @workgroup_size(1) fn main() {}")).toThrow(expect.objectContaining({ code: "VGPU-GPU-DISPOSED" }));
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
  const gpu = await initBrowser({ device });
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
  const gpu = await initBrowser({ device: externalDevice() });
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
  const gpu = await initBrowser({ device });
  const pending = frame(gpu);
  lose({ reason: "destroyed", message: "owner destroyed it" });
  await Promise.resolve();
  expect(() => pending.submit()).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
  gpu.dispose();
});

test("retained compute reports device loss reason", async () => {
  const { device, lose } = losableDevice();
  const gpu = await initBrowser({ device });
  const pipeline = compute(gpu, "@compute @workgroup_size(1) fn main() {}");
  lose({ reason: "unknown", message: "runtime lost" });
  await Promise.resolve();
  expect(() => pipeline.dispatch(1)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST", message: expect.stringContaining("runtime lost") }));
  gpu.dispose();
});

test("hostile plain-JS init options use stable validation codes", async () => {
  await expect(initBrowser(null as never)).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
  const throwingDevice = Object.defineProperty({}, "device", { get() { throw new Error("getter boom"); } });
  await expect(initBrowser(throwingDevice as never)).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
});

test("shared uniforms reject a disposed backing buffer", async () => {
  const gpu = await initBrowser({ device: externalDevice() });
  const shared = uniforms(gpu, { value: 1 });
  const pipeline = compute(gpu, "struct U { value: f32 }; @group(0) @binding(0) var<uniform> u: U; @compute @workgroup_size(1) fn main() { let x = u.value; }");
  pipeline.set({ u: shared });
  const buffer = (shared as unknown as { buffer: import("@vgpu/core").Buffer }).buffer;
  buffer.dispose();
  expect(() => pipeline.set({ u: shared })).toThrow(expect.objectContaining({ code: "VGPU-BUFFER-DISPOSED" }));
  gpu.dispose();
});

test.each([
  ["browser", initBrowser],
  ["node", initNode],
] as const)("%s snapshots every requested-device option once", async (_entry, init) => {
  const reads = Object.fromEntries(["adapter", "powerPreference", "requiredFeatures", "requiredLimits", "label"].map((key) => [key, 0])) as Record<string, number>;
  const adapter = { requestDevice: vi.fn(async () => new Device(externalDevice())) };
  const values: Record<string, unknown> = { adapter, powerPreference: "high-performance", requiredFeatures: [], requiredLimits: {}, label: "single-read" };
  const options = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(values)) Object.defineProperty(options, key, { enumerable: true, get() { reads[key]++; return values[key]; } });
  const gpu = await init(options as never);
  expect(reads).toEqual({ adapter: 1, powerPreference: 1, requiredFeatures: 1, requiredLimits: 1, label: 1 });
  gpu.dispose();
});

test("node snapshots hostile device getters once", async () => {
  let reads = 0;
  const options = Object.defineProperty({}, "device", { get() { reads++; throw new Error("boom"); } });
  await expect(initNode(options as never)).rejects.toMatchObject({ code: "VGPU-INIT-DEVICE-INVALID" });
  expect(reads).toBe(1);
});

test("frame state rejects reads and advances after loss", async () => {
  const { device, lose } = losableDevice();
  const gpu = await initBrowser({ device });
  lose({ reason: "destroyed", message: "state lost" });
  await Promise.resolve(); await Promise.resolve();
  // `clock(gpu)` is the frame-state entry point since 0.2.0; it must refuse a device that is gone.
  expect(() => clock(gpu).time).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
  expect(() => clock(gpu).advance(1)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
});

test("exclusive InitOptions rejects mixed forms at compile time", () => {
  // @ts-expect-error external device cannot be combined with a label
  const invalid: Parameters<typeof initBrowser>[0] = { device: externalDevice(), label: "mixed" };
  expect(invalid).toBeDefined();
});
