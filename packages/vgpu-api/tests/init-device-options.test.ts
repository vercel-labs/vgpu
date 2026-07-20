import { expect, test, vi } from "vitest";
import { createMockGPUDevice, Device, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";
import { init } from "../src/mock.ts";

test("explicit adapters receive required features and limits unchanged", async () => {
  const requestDevice = vi.fn(async (_opts?: CreateDeviceOptions) => new Device(createMockGPUDevice()));
  const adapter: VGPUAdapter = { requestDevice };
  const requiredFeatures = ["timestamp-query"] as const;
  const requiredLimits = { maxStorageBuffersInVertexStage: 2 };
  const gpu = await init({ adapter, requiredFeatures, requiredLimits });

  expect(requestDevice).toHaveBeenCalledOnce();
  expect(requestDevice.mock.calls[0]?.[0]).toMatchObject({ requiredFeatures, requiredLimits });
  expect(requestDevice.mock.calls[0]?.[0]?.requiredFeatures).toBe(requiredFeatures);
  expect(requestDevice.mock.calls[0]?.[0]?.requiredLimits).toBe(requiredLimits);
  gpu.dispose();
});

test("omitted device capabilities remain omitted", async () => {
  const requestDevice = vi.fn(async (_opts?: CreateDeviceOptions) => new Device(createMockGPUDevice()));
  const gpu = await init({ adapter: { requestDevice } });
  expect(requestDevice.mock.calls[0]?.[0]?.requiredFeatures).toBeUndefined();
  expect(requestDevice.mock.calls[0]?.[0]?.requiredLimits).toBeUndefined();
  gpu.dispose();
});
