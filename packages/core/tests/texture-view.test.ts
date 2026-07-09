import { expect, test } from "vitest";
import { Device, ValidationError, cubeView, layerView } from "../src/index.ts";

function createRecordingDevice(): { device: Device; viewDescriptors: GPUTextureViewDescriptor[] } {
  const viewDescriptors: GPUTextureViewDescriptor[] = [];
  const device = new Device({
    createTexture(desc: GPUTextureDescriptor): GPUTexture {
      const size = textureSize(desc.size);
      return createRecordingTexture(viewDescriptors, size.depthOrArrayLayers);
    },
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
    destroy() {},
  } as GPUDevice);
  return { device, viewDescriptors };
}

function createRecordingTexture(viewDescriptors: GPUTextureViewDescriptor[], depthOrArrayLayers: number): GPUTexture {
  return {
    depthOrArrayLayers,
    createView(desc?: GPUTextureViewDescriptor): GPUTextureView {
      viewDescriptors.push(desc ?? {});
      return { descriptor: desc } as unknown as GPUTextureView;
    },
    destroy() {},
  } as GPUTexture;
}

function textureSize(size: GPUExtent3DStrict): { depthOrArrayLayers: number } {
  if (Array.isArray(size)) return { depthOrArrayLayers: size[2] ?? 1 };
  return { depthOrArrayLayers: size.depthOrArrayLayers ?? 1 };
}

test("cubeView creates a core cube view over exactly six array layers", () => {
  const { device, viewDescriptors } = createRecordingDevice();
  const texture = device.createTexture({ size: [16, 16, 6], format: "rgba8unorm", usage: ["texture_binding"] });

  cubeView(texture, { compat: false, label: "skybox.cube" });

  expect(viewDescriptors).toEqual([{ label: "skybox.cube", dimension: "cube", baseArrayLayer: 0, arrayLayerCount: 6 }]);
});

test("cubeView creates a compatibility-safe 2d-array view when compat is true", () => {
  const { device, viewDescriptors } = createRecordingDevice();
  const texture = device.createTexture({ size: [16, 16, 6], format: "rgba8unorm", usage: ["texture_binding"] });

  cubeView(texture, { compat: true });

  expect(viewDescriptors).toEqual([{ dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 6 }]);
});

test("cubeView throws ValidationError unless the texture has exactly six array layers", () => {
  const { device } = createRecordingDevice();
  const texture = device.createTexture({ size: [16, 16, 5], format: "rgba8unorm", usage: ["texture_binding"] });

  expect(() => cubeView(texture, { compat: false })).toThrowError(ValidationError);
  expect(() => cubeView(texture, { compat: false })).toThrow("exactly 6 array layers");
});

test("cubeView throws ValidationError unless compat is explicit", () => {
  const { device } = createRecordingDevice();
  const texture = device.createTexture({ size: [16, 16, 6], format: "rgba8unorm", usage: ["texture_binding"] });

  expect(() => cubeView(texture, {} as never)).toThrowError(ValidationError);
  expect(() => cubeView(texture, {} as never)).toThrow("explicit boolean compat");
});

test("cubeView accepts raw GPUTexture objects", () => {
  const viewDescriptors: GPUTextureViewDescriptor[] = [];
  const texture = createRecordingTexture(viewDescriptors, 6);

  cubeView(texture, { compat: true, label: "raw.cube" });

  expect(viewDescriptors).toEqual([{ label: "raw.cube", dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 6 }]);
});

test("layerView creates a single-layer 2d view and pins mipLevel when provided", () => {
  const { device, viewDescriptors } = createRecordingDevice();
  const texture = device.createTexture({ size: [16, 16, 6], format: "rgba8unorm", usage: ["render_attachment"], mipLevelCount: 4 });

  layerView(texture, 3, { mipLevel: 2, format: "rgba8unorm-srgb", aspect: "all", label: "face.3.mip.2" });

  expect(viewDescriptors).toEqual([
    {
      label: "face.3.mip.2",
      dimension: "2d",
      baseArrayLayer: 3,
      arrayLayerCount: 1,
      baseMipLevel: 2,
      mipLevelCount: 1,
      format: "rgba8unorm-srgb",
      aspect: "all",
    },
  ]);
});
