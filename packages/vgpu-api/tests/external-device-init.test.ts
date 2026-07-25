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

test("exclusive InitOptions rejects mixed forms at compile time", () => {
  // @ts-expect-error external device cannot be combined with a label
  const invalid: Parameters<typeof initBrowser>[0] = { device: externalDevice(), label: "mixed" };
  expect(invalid).toBeDefined();
});
