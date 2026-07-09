import { expect, test } from "vitest";
import { Device } from "../src/device.ts";
import { ValidationError } from "../src/errors.ts";
import { Texture } from "../src/texture.ts";

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

function createRecordingDevice(): { device: Device; descriptors: GPUTextureDescriptor[]; destroyed: GPUTexture[] } {
  const descriptors: GPUTextureDescriptor[] = [];
  const destroyed: GPUTexture[] = [];
  const device = new Device({
    createTexture(desc: GPUTextureDescriptor): GPUTexture {
      descriptors.push(desc);
      const texture = {
        sampleCount: desc.sampleCount ?? 1,
        createView: () => ({ texture, view: {} }) as unknown as GPUTextureView,
        destroy() { destroyed.push(texture as GPUTexture); },
      } as GPUTexture;
      return texture;
    },
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
    destroy() {},
  } as GPUDevice);
  return { device, descriptors, destroyed };
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

test("Texture.resize no-ops when extent is unchanged", () => {
  const { device, descriptors } = createRecordingDevice();
  const texture = device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: ["render_attachment"] });
  const gpu = texture.gpu;

  expect(texture.resize([4, 4])).toBe(false);

  expect(texture.gpu).toBe(gpu);
  expect(texture.size).toEqual([4, 4]);
  expect(descriptors).toHaveLength(1);
  texture.destroy();
  device.destroy();
});

test("Texture.resize reallocates with the same descriptor except extent", () => {
  const { device, descriptors, destroyed } = createRecordingDevice();
  const texture = device.createTexture({
    label: "target",
    size: [8, 8, 6],
    format: "rgba8unorm",
    usage: ["texture_binding", "render_attachment"],
    mipLevelCount: 4,
    sampleCount: 4,
    dimension: "2d",
    viewFormats: ["rgba8unorm-srgb"],
  });
  const originalGpu = texture.gpu;

  expect(texture.resize([16, 12])).toBe(true);

  expect(texture.gpu).not.toBe(originalGpu);
  expect(destroyed).toContain(originalGpu);
  expect(texture.size).toEqual([16, 12, 6]);
  expect(descriptors).toHaveLength(2);
  expect(descriptors[1]).toMatchObject({
    label: "target",
    size: { width: 16, height: 12, depthOrArrayLayers: 6 },
    format: "rgba8unorm",
    mipLevelCount: 4,
    sampleCount: 4,
    dimension: "2d",
    viewFormats: ["rgba8unorm-srgb"],
  });
  expect(descriptors[1].usage).toBe(20);
  expect(texture.format).toBe("rgba8unorm");
  expect(texture.usage).toEqual(["texture_binding", "render_attachment"]);
  expect(texture.mipLevelCount).toBe(4);
  expect(texture.sampleCount).toBe(4);
  expect(texture.dimension).toBe("2d");
  expect(texture.viewFormats).toEqual(["rgba8unorm-srgb"]);
  texture.destroy();
  device.destroy();
});

test("Texture.resize 2-tuple keeps depthOrArrayLayers omitted when it was omitted", () => {
  const { device, descriptors } = createRecordingDevice();
  const texture = device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: ["render_attachment"] });

  expect(texture.resize([8, 8])).toBe(true);

  expect(texture.size).toEqual([8, 8]);
  expect(descriptors[1].size).toEqual({ width: 8, height: 8, depthOrArrayLayers: 1 });
  texture.destroy();
  device.destroy();
});

test("Texture.resize 3-tuple overrides depthOrArrayLayers", () => {
  const { device, descriptors } = createRecordingDevice();
  const texture = device.createTexture({ size: [8, 8, 6], format: "rgba8unorm", usage: ["render_attachment"] });

  expect(texture.resize([16, 12, 2])).toBe(true);

  expect(texture.size).toEqual([16, 12, 2]);
  expect(descriptors[1].size).toEqual({ width: 16, height: 12, depthOrArrayLayers: 2 });
  texture.destroy();
  device.destroy();
});

test("Texture.resize throws after destroy", () => {
  const device = createDevice();
  const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: ["render_attachment"] });

  texture.destroy();

  expect(() => texture.resize([2, 2])).toThrowError(ValidationError);
  expect(() => texture.resize([2, 2])).toThrow("Texture is destroyed");
  device.destroy();
});

test("Texture.resize throws for externally owned textures", () => {
  const rawTexture = { createView: () => ({}), destroy() {} } as GPUTexture;
  const texture = new Texture({} as Device, rawTexture, { size: [1, 1], format: "rgba8unorm", usage: ["render_attachment"] }, "external");

  expect(() => texture.resize([2, 2])).toThrow("externally owned");
  expect(() => texture.resize([2, 2])).toThrowError(ValidationError);
});

test("Texture.view caches the default view and invalidates on resize and destroy", () => {
  const { device } = createRecordingDevice();
  const texture = device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: ["render_attachment"] });

  const firstView = texture.view;
  expect(texture.view).toBe(firstView);

  expect(texture.resize([8, 8])).toBe(true);
  const resizedView = texture.view;
  expect(resizedView).not.toBe(firstView);
  expect(texture.view).toBe(resizedView);

  texture.destroy();
  expect(() => texture.view).toThrow("Texture is destroyed");
  device.destroy();
});
