import { expect, test } from "vitest";
import { Buffer } from "../src/buffer.ts";
import { Device } from "../src/device.ts";
import { Texture } from "../src/texture.ts";

function createDevice(): Device {
  return new Device({
    createBuffer(): GPUBuffer {
      return { destroy() {} } as GPUBuffer;
    },
    createTexture(): GPUTexture {
      return { createView: () => ({}), destroy() {} } as GPUTexture;
    },
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
    destroy() {},
  } as GPUDevice);
}

test("Buffer exposes stable resource identity and one-shot destroy callbacks", () => {
  const device = createDevice();
  const buffer = device.createBuffer({ size: 4, usage: ["copy_dst"] });
  const calls: unknown[] = [];

  const identity = buffer.resourceIdentity;
  const unsubscribe = buffer.onDestroy((resource) => calls.push(resource));

  expect(buffer.resourceIdentity).toBe(identity);
  buffer.destroy();
  buffer.destroy();

  expect(calls).toEqual([buffer]);
  unsubscribe();
  device.destroy();
});

test("Texture exposes stable resource identity and destroy callbacks can unsubscribe", () => {
  const device = createDevice();
  const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: ["render_attachment"] });
  const calls: Texture[] = [];

  const identity = texture.resourceIdentity;
  const unsubscribe = texture.onDestroy((resource) => calls.push(resource));
  unsubscribe();
  texture.onDestroy((resource) => calls.push(resource));

  expect(texture.resourceIdentity).toBe(identity);
  texture.destroy();
  texture.destroy();

  expect(calls).toEqual([texture]);
  device.destroy();
});

test("onDestroy registered after destroy fires immediately", () => {
  const buffer = new Buffer({} as Device, { destroy() {} } as GPUBuffer, { size: 4, usage: ["copy_dst"] });
  const calls: Buffer[] = [];

  buffer.destroy();
  const unsubscribe = buffer.onDestroy((resource) => calls.push(resource));

  expect(calls).toEqual([buffer]);
  expect(() => unsubscribe()).not.toThrow();
});
