import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, VGPUError } from "@vgpu/core";
import { mat4 } from "wgpu-matrix";
import { degToRad, Mesh, pbrMaterial, perspectiveCamera, RapidRenderer } from "@vgpu/render";

const LIGHT_DIRECTION_OFFSET = 144;

test("draw with material+mesh+camera issues a uniform upload and a draw call", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, mesh, camera, target, depthTarget } = makeDomainDraw(device);
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");

  await renderer.draw({ material, mesh, camera, transform: mat4.identity(), target, depthTarget });

  expect(writeBuffer).toHaveBeenCalled();
  const call = writeBuffer.mock.calls[0];
  expect(call[0]).toBeTruthy();
  expect(call[2]).toBeInstanceOf(ArrayBuffer);
  expect(call[4]).toBeGreaterThanOrEqual(material.uniformByteSize);
  device.destroy();
});

test("draw without material/mesh/camera uses the minimum path", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const renderer = new RapidRenderer(device);
  const pipeline = device.gpu.createRenderPipeline({
    layout: "auto",
    vertex: { module: device.gpu.createShaderModule({ code: "@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }" }), entryPoint: "main" },
  });
  const target = textureView(device, "bgra8unorm-srgb");
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");

  await renderer.draw({ pipeline, target, vertexCount: 3 });

  expect(writeBuffer).not.toHaveBeenCalled();
  device.destroy();
});

test("draw with material but no mesh throws VGPU-CORE-INVALID-USAGE", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, camera, target, depthTarget } = makeDomainDraw(device);
  await expect(renderer.draw({ material, camera, target, depthTarget })).rejects.toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
  device.destroy();
});

test("draw with material but no camera throws VGPU-CORE-INVALID-USAGE", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, mesh, target, depthTarget } = makeDomainDraw(device);
  await expect(renderer.draw({ material, mesh, target, depthTarget })).rejects.toBeInstanceOf(VGPUError);
  await expect(renderer.draw({ material, mesh, target, depthTarget })).rejects.toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
  device.destroy();
});

test("draw with material but no depthTarget throws VGPU-CORE-INVALID-USAGE", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, mesh, camera, target } = makeDomainDraw(device);
  await expect(renderer.draw({ material, mesh, camera, target })).rejects.toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
  device.destroy();
});

test("draw with same material twice reuses the uniform slot", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, mesh, camera, target, depthTarget } = makeDomainDraw(device);
  const createBindGroup = vi.spyOn(device.gpu, "createBindGroup");

  await renderer.draw({ material, mesh, camera, target, depthTarget });
  await renderer.draw({ material, mesh, camera, target, depthTarget });

  expect(createBindGroup).toHaveBeenCalledTimes(1);
  device.destroy();
});

test("draw populates uniform bytes with normalized light direction", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, mesh, camera, target, depthTarget } = makeDomainDraw(device);
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");

  await renderer.draw({ material, mesh, camera, target, depthTarget, light: { direction: [-2, 0, 0], color: [1, 1, 1], intensity: 1 } });

  const floats = new Float32Array(writeBuffer.mock.calls[0][2] as ArrayBuffer);
  const lightOffset = LIGHT_DIRECTION_OFFSET / Float32Array.BYTES_PER_ELEMENT;
  expect(Array.from(floats.slice(lightOffset, lightOffset + 3))).toEqual([-1, 0, 0]);
  device.destroy();
});

function makeDomainDraw(device: Awaited<ReturnType<typeof App.create>>["device"]) {
  return {
    renderer: new RapidRenderer(device),
    material: pbrMaterial({ device, baseColor: [0.5, 0.5, 0.5] }),
    mesh: Mesh.box({ device, size: 1 }),
    camera: perspectiveCamera({ fovYRadians: degToRad(45), aspect: 1, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] }),
    target: textureView(device, "bgra8unorm-srgb"),
    depthTarget: textureView(device, "depth24plus"),
  };
}

function textureView(device: Awaited<ReturnType<typeof App.create>>["device"], format: GPUTextureFormat): GPUTextureView {
  return device.createTexture({ size: [4, 4], format, usage: ["render_attachment"] }).createView();
}
