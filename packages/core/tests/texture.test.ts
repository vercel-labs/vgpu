import { expect, test } from "vitest";
import { Device } from "../src/device.ts";

function createDevice(): Device {
  return new Device({
    createTexture(desc: GPUTextureDescriptor): GPUTexture {
      return {
        sampleCount: desc.sampleCount ?? 1,
        createView: () => ({}) as GPUTextureView,
        destroy() {},
      } as GPUTexture;
    },
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
    destroy() {},
  } as GPUDevice);
}

function createRecordingDevice(): { device: Device; descriptors: GPUTextureDescriptor[] } {
  const descriptors: GPUTextureDescriptor[] = [];
  const device = new Device({
    createTexture(desc: GPUTextureDescriptor): GPUTexture {
      descriptors.push(desc);
      return {
        sampleCount: desc.sampleCount ?? 1,
        createView: () => ({}) as GPUTextureView,
        destroy() {},
      } as GPUTexture;
    },
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
    destroy() {},
  } as GPUDevice);
  return { device, descriptors };
}

test("Texture.create defaults to sampleCount 1", () => {
  const device = createDevice();

  const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: ["render_attachment"] });

  expect(texture.gpu.sampleCount).toBe(1);
  texture.destroy();
  device.destroy();
});

test("Texture.create accepts sampleCount: 4 for MSAA", () => {
  const device = createDevice();

  const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: ["render_attachment"], sampleCount: 4 });

  expect(texture.gpu.sampleCount).toBe(4);
  texture.destroy();
  device.destroy();
});

test("Texture.create passes explicit texture descriptor fields through", () => {
  const { device, descriptors } = createRecordingDevice();

  const texture = device.createTexture({
    size: [8, 8, 6],
    format: "rgba8unorm",
    usage: ["texture_binding", "render_attachment"],
    mipLevelCount: 4,
    sampleCount: 4,
    dimension: "2d",
    viewFormats: ["rgba8unorm-srgb"],
  });

  expect(descriptors).toHaveLength(1);
  expect(descriptors[0]).toMatchObject({
    size: { width: 8, height: 8, depthOrArrayLayers: 6 },
    format: "rgba8unorm",
    mipLevelCount: 4,
    sampleCount: 4,
    dimension: "2d",
    viewFormats: ["rgba8unorm-srgb"],
  });
  expect(descriptors[0].usage).toBe(20);
  expect(texture.mipLevelCount).toBe(4);
  expect(texture.sampleCount).toBe(4);
  expect(texture.dimension).toBe("2d");
  expect(texture.viewFormats).toEqual(["rgba8unorm-srgb"]);
  texture.destroy();
  device.destroy();
});

test("Texture.create leaves native texture descriptor defaults omitted", () => {
  const { device, descriptors } = createRecordingDevice();

  const texture = device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: ["copy_src"] });

  expect(descriptors).toHaveLength(1);
  expect(descriptors[0]).toMatchObject({
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: "rgba8unorm",
    usage: 1,
  });
  expect(descriptors[0]).not.toHaveProperty("mipLevelCount");
  expect(descriptors[0]).not.toHaveProperty("sampleCount");
  expect(descriptors[0]).not.toHaveProperty("dimension");
  expect(descriptors[0]).not.toHaveProperty("viewFormats");
  expect(texture.mipLevelCount).toBe(1);
  expect(texture.sampleCount).toBe(1);
  expect(texture.dimension).toBe("2d");
  expect(texture.viewFormats).toEqual([]);
  texture.destroy();
  device.destroy();
});
