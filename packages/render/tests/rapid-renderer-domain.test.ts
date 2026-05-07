import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";
import { mat4 } from "wgpu-matrix";
import { degToRad, Mesh, perspectiveCamera, RapidRenderer } from "@vgpu/render";
import { litMaterial } from "./fixtures/lit-material/index.ts";

const LIGHT_DIRECTION_OFFSET = 144;

test("litMaterial.writeUniforms uploads bytes with normalized light direction", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { material, camera } = makeDomainDraw(device);
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");

  material.writeUniforms({
    viewProjection: camera.viewProjectionMatrix,
    model: mat4.identity(),
    cameraPosition: camera.position,
    light: { direction: [-2, 0, 0], color: [1, 1, 1], intensity: 1 },
  });

  const floats = new Float32Array((writeBuffer.mock.calls[0][2] as Float32Array).buffer);
  const lightOffset = LIGHT_DIRECTION_OFFSET / Float32Array.BYTES_PER_ELEMENT;
  expect(Array.from(floats.slice(lightOffset, lightOffset + 3))).toEqual([-1, 0, 0]);
  device.destroy();
});

test("litMaterial.writeUniforms rejects missing and unknown uniforms", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { material, camera } = makeDomainDraw(device);
  const values = {
    viewProjection: camera.viewProjectionMatrix,
    model: mat4.identity(),
    cameraPosition: camera.position,
    light: { direction: [-1, 0, 0], color: [1, 1, 1], intensity: 1 },
  };

  expect(() => material.writeUniforms({ ...values, extra: 1 })).toThrow(/Unknown uniform 'extra'/);
  expect(() => material.writeUniforms({ model: mat4.identity(), cameraPosition: camera.position, light: values.light } as never)).toThrow(/Missing uniform 'viewProjection'/);
  device.destroy();
});

test("draw with material and mesh issues no uniform upload", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, mesh, target, depthTarget } = makeDomainDraw(device);
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");

  await renderer.draw({ material, mesh, target, depthTarget });

  expect(writeBuffer).not.toHaveBeenCalled();
  device.destroy();
});

test("draw with material but no mesh or vertexCount throws VGPU-CORE-INVALID-USAGE", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, target, depthTarget } = makeDomainDraw(device);
  await expect(renderer.draw({ material, target, depthTarget })).rejects.toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
  device.destroy();
});

test("draw can use vertexCount without a mesh", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const { renderer, material, target } = makeDomainDraw(device);

  await expect(renderer.draw({ material, target, vertexCount: 3 })).resolves.toBeUndefined();
  device.destroy();
});

function makeDomainDraw(device: Awaited<ReturnType<typeof App.create>>["device"]) {
  return {
    renderer: new RapidRenderer(device),
    material: litMaterial({ device, baseColor: [0.5, 0.5, 0.5] }),
    mesh: Mesh.box({ device, size: 1 }),
    camera: perspectiveCamera({ fovYRadians: degToRad(45), aspect: 1, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] }),
    target: textureView(device, "bgra8unorm-srgb"),
    depthTarget: textureView(device, "depth24plus"),
  };
}

function textureView(device: Awaited<ReturnType<typeof App.create>>["device"], format: GPUTextureFormat): GPUTextureView {
  return device.createTexture({ size: [4, 4], format, usage: ["render_attachment"] }).createView();
}
