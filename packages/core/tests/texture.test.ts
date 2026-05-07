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
