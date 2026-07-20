import { afterEach, expect, test, vi } from "vitest";
import { createMockGPUDevice, Device, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";
import { init as initBrowser } from "../src/index.ts";
import { init } from "../src/mock.ts";

afterEach(() => vi.unstubAllGlobals());

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

test("browser adapter receives required features and limits unchanged", async () => {
  const gpuDevice = createMockGPUDevice();
  const requestDevice = vi.fn(async () => gpuDevice);
  const requestAdapter = vi.fn(async () => ({ requestDevice, info: null } as unknown as GPUAdapter));
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  const requiredFeatures = ["timestamp-query"] as const;
  const requiredLimits = { maxStorageBuffersInVertexStage: 3 };
  const gpu = await initBrowser({ requiredFeatures, requiredLimits });
  expect(requestDevice).toHaveBeenCalledWith({ requiredFeatures, requiredLimits });
  gpu.dispose();
});

test("omitted device capabilities remain omitted", async () => {
  const requestDevice = vi.fn(async (_opts?: CreateDeviceOptions) => new Device(createMockGPUDevice()));
  const gpu = await init({ adapter: { requestDevice } });
  expect(requestDevice.mock.calls[0]?.[0]?.requiredFeatures).toBeUndefined();
  expect(requestDevice.mock.calls[0]?.[0]?.requiredLimits).toBeUndefined();
  gpu.dispose();
});
