import { expect, test } from "vitest";
import { Device, createMockGPUDevice, getMockGPUDeviceInstrumentation } from "../src/index.ts";

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

test("mock GPU device reflects the features it was created with", () => {
  const gpu = createMockGPUDevice({ features: ["depth-clip-control"] });
  const device = new Device(gpu);

  expect(device.features.has("depth-clip-control")).toBe(true);
  expect(device.features.has("timestamp-query")).toBe(false);
  expect(device.features.size).toBe(1);
});

test("Device.isCompatibilityMode defaults false and can be set by adapters", () => {
  const gpu = createMockGPUDevice();

  expect(new Device(gpu).isCompatibilityMode).toBe(false);
  expect(new Device(gpu, null, { isCompatibilityMode: true }).isCompatibilityMode).toBe(true);
});

test("mock GPU device creates instrumented query sets", () => {
  const gpu = createMockGPUDevice();
  const querySet = gpu.createQuerySet({ type: "timestamp", count: 64, label: "ts" });

  expect(querySet.type).toBe("timestamp");
  expect(querySet.count).toBe(64);
  expect(querySet.label).toBe("ts");
  expect(() => querySet.destroy()).not.toThrow();
  const instrumentation = getMockGPUDeviceInstrumentation(gpu);
  expect(instrumentation.calls.createQuerySet).toBe(1);
  expect(instrumentation.createQuerySetDescriptors).toEqual([{ type: "timestamp", count: 64, label: "ts" }]);
});

test("mock resolveQuerySet writes deterministic u64 values and copyBufferToBuffer copies them", async () => {
  const gpu = createMockGPUDevice();
  const device = new Device(gpu);
  const querySet = gpu.createQuerySet({ type: "timestamp", count: 8 });
  const resolve = device.createBuffer({ size: 4 * 8, usage: ["query_resolve", "copy_src"] });
  const staging = device.createBuffer({ size: 4 * 8, usage: ["map_read", "copy_dst"] });

  const encoder = gpu.createCommandEncoder();
  encoder.resolveQuerySet(querySet, 0, 4, resolve.gpu, 0);
  encoder.copyBufferToBuffer(resolve.gpu, 0, staging.gpu, 0, 4 * 8);
  gpu.queue.submit([encoder.finish()]);

  // Fake value for query index i is i * i * 1e6, so map/decode paths are testable end-to-end.
  await staging.gpu.mapAsync(1);
  const values = new BigUint64Array(staging.gpu.getMappedRange().slice(0, 4 * 8));
  staging.gpu.unmap();
  expect([...values]).toEqual([0n, 1_000_000n, 4_000_000n, 9_000_000n]);
});

test("mock render pass encoders record occlusion query scopes; bundle encoders have no query methods, matching WebGPU", () => {
  const gpu = createMockGPUDevice();
  const encoder = gpu.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [] });

  pass.beginOcclusionQuery(0);
  pass.endOcclusionQuery();
  pass.beginOcclusionQuery(3);
  pass.endOcclusionQuery();
  pass.end();

  const instrumentation = getMockGPUDeviceInstrumentation(gpu);
  expect(instrumentation.occlusionQueryOps).toEqual([["begin", 0], ["end"], ["begin", 3], ["end"]]);
  // GPURenderBundleEncoder has no beginOcclusionQuery/endOcclusionQuery in WebGPU; the mock matches.
  const bundleEncoder = gpu.createRenderBundleEncoder({ colorFormats: ["rgba8unorm"] });
  expect("beginOcclusionQuery" in bundleEncoder).toBe(false);
  expect("endOcclusionQuery" in bundleEncoder).toBe(false);
});

test("mock command encoder implements the copy methods callers reach for", () => {
  const encoder = createMockGPUDevice().createCommandEncoder();

  for (const method of ["copyBufferToBuffer", "copyTextureToBuffer", "copyTextureToTexture"] as const) {
    expect(typeof encoder[method], `encoder.${method} is missing from the mock`).toBe("function");
  }
});
