import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, Shader } from "@vgpu/core";
import { pbrMaterial } from "@vgpu/render";

test("pbrMaterial produces a valid render pipeline against mock device", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const material = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] });

  expect(material.pipeline).toBeTruthy();
  expect(material.bindGroupLayout).toBeTruthy();
  expect(material.shader).toBeInstanceOf(Shader);
  expect(material.uniformByteSize).toBe(224);
  expect(material.params).toEqual({ baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 });
  device.destroy();
});

test("pbrMaterial caches per-device per-spec", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const a = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] });
  const b = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] });
  expect(a).toBe(b);
  device.destroy();
});

test("pbrMaterial with different baseColor returns different Material", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const a = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] });
  const c = pbrMaterial({ device, baseColor: [0.4, 0.5, 0.5] });
  expect(a).not.toBe(c);
  device.destroy();
});

test("pbrMaterial with different metallic/roughness returns different Material", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const a = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5], metallic: 0.1, roughness: 0.5 });
  const b = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5], metallic: 0.2, roughness: 0.5 });
  const c = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5], metallic: 0.1, roughness: 0.6 });
  expect(a).not.toBe(b);
  expect(a).not.toBe(c);
  device.destroy();
});

test("pbrMaterial with different devices returns different Material", async () => {
  const { device: deviceA } = await App.create({ adapter: createMockAdapter() });
  const { device: deviceB } = await App.create({ adapter: createMockAdapter() });
  const a = pbrMaterial({ device: deviceA, baseColor: [0.5, 0.5, 0.5] });
  const b = pbrMaterial({ device: deviceB, baseColor: [0.5, 0.5, 0.5] });
  expect(a).not.toBe(b);
  deviceA.destroy();
  deviceB.destroy();
});

test("pbrMaterial defaults metallic=0 and roughness=0.5", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const a = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] });
  const b = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 });
  expect(a).toBe(b);
  device.destroy();
});

test("pbrMaterial with targetFormat=rgba8unorm-srgb produces a pipeline configured for that format", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const createRenderPipeline = vi.spyOn(device.gpu, "createRenderPipeline");
  const bgra = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5], targetFormat: "bgra8unorm-srgb" });
  const rgba = pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5], targetFormat: "rgba8unorm-srgb" });
  expect(bgra).not.toBe(rgba);
  expect(createRenderPipeline).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      fragment: expect.objectContaining({ targets: [expect.objectContaining({ format: "rgba8unorm-srgb" })] }),
    }),
  );
  device.destroy();
});

test("pbrMaterial WGSL source compiles via device.createShader", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const createShaderModule = vi.spyOn(device.gpu, "createShaderModule");

  pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] });
  expect(createShaderModule).toHaveBeenCalledOnce();
  expect(createShaderModule).toHaveBeenCalledWith({ code: expect.stringContaining("vs_main") });
  expect(createShaderModule).toHaveBeenCalledWith({ code: expect.stringContaining("fs_main") });

  pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] });
  expect(createShaderModule).toHaveBeenCalledOnce();
  device.destroy();
});
