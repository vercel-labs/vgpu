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

  const texture = device.createTexture({ kind: "2d", size: [1, 1], format: "rgba8unorm", usage: ["render_attachment"] });

  expect(texture.gpu.sampleCount).toBe(1);
  texture.destroy();
  device.destroy();
});

test("Texture.create accepts sampleCount: 4 for MSAA", () => {
  const device = createDevice();

  const texture = device.createTexture({ kind: "2d", size: [1, 1], format: "rgba8unorm", usage: ["render_attachment"], sampleCount: 4 });

  expect(texture.gpu.sampleCount).toBe(4);
  texture.destroy();
  device.destroy();
});

test("Texture.create passes explicit texture descriptor fields through", () => {
  const { device, descriptors } = createRecordingDevice();

  const texture = device.createTexture({
    kind: "2d-array",
    size: [8, 8], layers: 6,
    format: "rgba8unorm",
    usage: ["texture_binding", "render_attachment"],
    mipLevelCount: 4,
    sampleCount: 1,

    viewFormats: ["rgba8unorm-srgb"],
  });

  expect(descriptors).toHaveLength(1);
  expect(descriptors[0]).toMatchObject({
    size: { width: 8, height: 8, depthOrArrayLayers: 6 },
    format: "rgba8unorm",
    mipLevelCount: 4,
    sampleCount: 1,
    dimension: "2d",
    viewFormats: ["rgba8unorm-srgb"],
  });
  expect(descriptors[0].usage).toBe(20);
  expect(texture.mipLevelCount).toBe(4);
  expect(texture.sampleCount).toBe(1);
  expect(texture.dimension).toBe("2d");
  expect(texture.viewFormats).toEqual(["rgba8unorm-srgb"]);
  texture.destroy();
  device.destroy();
});

test("Texture.create leaves native texture descriptor defaults omitted", () => {
  const { device, descriptors } = createRecordingDevice();

  const texture = device.createTexture({ kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["copy_src"] });

  expect(descriptors).toHaveLength(1);
  expect(descriptors[0]).toMatchObject({
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: "rgba8unorm",
    usage: 1,
  });
  expect(descriptors[0]).not.toHaveProperty("mipLevelCount");
  expect(descriptors[0]).not.toHaveProperty("sampleCount");
  expect(descriptors[0].dimension).toBe("2d");
  expect(descriptors[0]).not.toHaveProperty("viewFormats");
  expect(texture.mipLevelCount).toBe(1);
  expect(texture.sampleCount).toBe(1);
  expect(texture.dimension).toBe("2d");
  expect(texture.viewFormats).toEqual([]);
  texture.destroy();
  device.destroy();
});

test("Texture has fixed identity and cached views until destruction", () => {
  const { device } = createRecordingDevice();
  const texture = device.createTexture({ kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["render_attachment"] });

  const firstView = texture.view;
  expect(texture.view).toBe(firstView);

  expect("resize" in texture).toBe(false);
  expect(Object.getOwnPropertySymbols(texture)).not.toContain(Symbol.for("vgpu/Texture/resizeLock"));

  texture.destroy();
  expect(() => texture.view).toThrow("Texture is destroyed");
  device.destroy();
});

test("external wrappers invalidate without destroying the owner's resource", () => {
  let destroys = 0;
  const raw = { createView: () => ({}), destroy: () => { destroys++; } } as GPUTexture;
  const texture = new Texture({} as Device, raw, { kind: "2d", size: [1, 1], format: "rgba8unorm", usage: ["texture_binding"] }, "external");
  const calls: string[] = [];
  texture.onDestroy(() => calls.push("destroyed"));
  texture.destroy();
  texture.destroy();
  expect(calls).toEqual(["destroyed"]);
  expect(destroys).toBe(0);
  expect(() => texture.createView()).toThrowError(ValidationError);
});

test("throwing destroy callbacks do not skip invalidation or native cleanup", () => {
  const { device, destroyed } = createRecordingDevice();
  const texture = device.createTexture({ kind: "2d", size: [1, 1], format: "rgba8unorm", usage: ["texture_binding"] });
  let notified = false;
  texture.onDestroy(() => { throw new Error("consumer failure"); });
  texture.onDestroy(() => { notified = true; });
  expect(() => texture.destroy()).toThrow("consumer failure");
  expect(notified).toBe(true);
  expect(destroyed).toEqual([texture.gpu]);
  expect(() => texture.view).toThrow("destroyed");
  expect(() => texture.destroy()).not.toThrow();
});
