import { expect, test } from "vitest";
import { Device, createMockGPUDevice } from "../src/index.ts";

function createPassthroughGPUDevice(limits: GPUSupportedLimits, features: GPUSupportedFeatures): GPUDevice {
  return {
    limits,
    features,
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
    destroy() {},
  } as unknown as GPUDevice;
}

test("Device.limits and Device.features pass through the underlying GPUDevice capabilities", () => {
  const limits = { maxTextureDimension2D: 4096, maxColorAttachments: 4 } as GPUSupportedLimits;
  const features = new Set<GPUFeatureName>(["timestamp-query"] as GPUFeatureName[]) as unknown as GPUSupportedFeatures;
  const gpu = createPassthroughGPUDevice(limits, features);
  const device = new Device(gpu);

  expect(device.limits).toBe(limits);
  expect(device.features).toBe(features);
  expect(device.limits.maxTextureDimension2D).toBe(4096);
  expect(device.features.has("timestamp-query")).toBe(true);
});

test("mock GPU device exposes stable limits and setlike features", () => {
  const gpu = createMockGPUDevice();
  const device = new Device(gpu);

  expect(device.limits).toBe(gpu.limits);
  expect(device.features).toBe(gpu.features);
  expect(device.limits.maxTextureDimension2D).toBe(8192);
  expect(device.limits.maxColorAttachments).toBe(8);
  expect(device.features.size).toBe(0);
  expect(device.features.has("timestamp-query")).toBe(false);
});
