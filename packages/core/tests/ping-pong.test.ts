import { expect, test } from "vitest";
import { Device, pingPong } from "../src/index.ts";

function createDevice(): Device {
  return new Device(createInspectableGPUDevice());
}

function createInspectableGPUDevice(): GPUDevice {
  const gpu = createMockBaseGPUDevice();
  const destroyCounts = { buffer: 0, texture: 0 };

  return {
    ...gpu,
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const buffer = gpu.createBuffer(desc);
      const destroy = buffer.destroy?.bind(buffer);
      return {
        ...buffer,
        destroy() {
          destroyCounts.buffer += 1;
          destroy?.();
        },
      } as GPUBuffer;
    },
    createTexture(desc: GPUTextureDescriptor): GPUTexture {
      const texture = gpu.createTexture(desc);
      const destroy = texture.destroy?.bind(texture);
      return {
        ...texture,
        destroy() {
          destroyCounts.texture += 1;
          destroy?.();
        },
      } as GPUTexture;
    },
    __destroyCounts: destroyCounts,
  } as GPUDevice;
}

function createMockBaseGPUDevice(): GPUDevice {
  return {
    limits: {} as GPUSupportedLimits,
    features: new Set<GPUFeatureName>() as unknown as GPUSupportedFeatures,
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      return { label: desc.label ?? "", size: desc.size, usage: desc.usage, destroy() {} } as GPUBuffer;
    },
    createTexture(desc: GPUTextureDescriptor): GPUTexture {
      return {
        label: desc.label ?? "",
        width: typeof desc.size === "object" && !Array.isArray(desc.size) ? desc.size.width : desc.size[0],
        height: typeof desc.size === "object" && !Array.isArray(desc.size) ? desc.size.height ?? 1 : desc.size[1] ?? 1,
        depthOrArrayLayers: typeof desc.size === "object" && !Array.isArray(desc.size) ? desc.size.depthOrArrayLayers ?? 1 : desc.size[2] ?? 1,
        sampleCount: desc.sampleCount ?? 1,
        createView: () => ({}) as GPUTextureView,
        destroy() {},
      } as GPUTexture;
    },
    createShaderModule: () => ({}) as GPUShaderModule,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createBindGroup: () => ({}) as GPUBindGroup,
    createSampler: () => ({}) as GPUSampler,
    queue: { submit() {}, writeBuffer() {}, onSubmittedWorkDone: async () => undefined },
    destroy() {},
  } as unknown as GPUDevice;
}

test("pingPong creates texture read/write halves and swaps parity", () => {
  const device = createDevice();

  const pair = pingPong(device, { label: "state", size: [16, 8], format: "rgba8unorm", usage: ["texture_binding", "render_attachment"] });
  const ping = pair.read;
  const pong = pair.write;

  expect(pair.size).toEqual([16, 8]);
  expect(ping.label).toBe("state.ping");
  expect(pong.label).toBe("state.pong");
  expect(ping.size).toEqual([16, 8]);
  expect(pong.size).toEqual([16, 8]);

  pair.swap();
  expect(pair.read).toBe(pong);
  expect(pair.write).toBe(ping);

  pair.reset();
  expect(pair.read).toBe(ping);
  expect(pair.write).toBe(pong);
});

test("pingPong texture resize reallocates both halves, resets parity, and preserves 3D size", () => {
  const device = createDevice();
  const pair = pingPong(device, { label: "volume", size: [8, 8, 2], format: "rgba16float", usage: ["texture_binding", "storage_binding"] });
  const originalRead = pair.read;
  const originalWrite = pair.write;

  pair.swap();
  expect(pair.resize([8, 8, 2])).toBe(false);
  expect(pair.read).toBe(originalWrite);
  expect(pair.write).toBe(originalRead);

  expect(pair.resize([4, 5, 6])).toBe(true);
  expect(pair.size).toEqual([4, 5, 6]);
  expect(pair.read).not.toBe(originalRead);
  expect(pair.write).not.toBe(originalWrite);
  expect(pair.read.label).toBe("volume.ping");
  expect(pair.write.label).toBe("volume.pong");
  expect(pair.read.size).toEqual([4, 5, 6]);
  expect(pair.write.size).toEqual([4, 5, 6]);
});

test("pingPong texture size snapshots are not affected by caller tuple mutation", () => {
  const device = createDevice();
  const initialSize: [number, number, number?] = [8, 8, 1];
  const pair = pingPong(device, { size: initialSize, format: "rgba8unorm", usage: ["copy_src"] });

  initialSize[0] = 99;
  expect(pair.size).toEqual([8, 8, 1]);
  expect(pair.read.size).toEqual([8, 8, 1]);
  expect(pair.write.size).toEqual([8, 8, 1]);

  const reportedSize = pair.size as [number, number, number?];
  reportedSize[1] = 99;
  expect(pair.size).toEqual([8, 8, 1]);

  const resizedSize: [number, number, number?] = [4, 5, 6];
  expect(pair.resize(resizedSize)).toBe(true);
  resizedSize[2] = 99;
  expect(pair.size).toEqual([4, 5, 6]);
  expect(pair.read.size).toEqual([4, 5, 6]);
  expect(pair.write.size).toEqual([4, 5, 6]);
});

test("pingPong creates buffer read/write halves and swaps parity", () => {
  const device = createDevice();

  const pair = pingPong(device, { label: "particles", size: 256, usage: ["storage", "vertex", "copy_dst"] });
  const ping = pair.read;
  const pong = pair.write;

  expect(pair.size).toBe(256);
  expect(ping.options.label).toBe("particles.ping");
  expect(pong.options.label).toBe("particles.pong");
  expect(ping.options.size).toBe(256);
  expect(pong.options.size).toBe(256);

  pair.swap();
  expect(pair.read).toBe(pong);
  expect(pair.write).toBe(ping);

  pair.reset();
  expect(pair.read).toBe(ping);
  expect(pair.write).toBe(pong);
});

test("pingPong buffer resize reallocates both halves and resets parity", () => {
  const device = createDevice();
  const pair = pingPong(device, { label: "particles", size: 128, usage: ["storage", "copy_dst"] });
  const originalRead = pair.read;
  const originalWrite = pair.write;

  pair.swap();
  expect(pair.resize(128)).toBe(false);
  expect(pair.read).toBe(originalWrite);
  expect(pair.write).toBe(originalRead);

  expect(pair.resize(512)).toBe(true);
  expect(pair.size).toBe(512);
  expect(pair.read).not.toBe(originalRead);
  expect(pair.write).not.toBe(originalWrite);
  expect(pair.read.options.label).toBe("particles.ping");
  expect(pair.write.options.label).toBe("particles.pong");
  expect(pair.read.options.size).toBe(512);
  expect(pair.write.options.size).toBe(512);
});

test("pingPong preserves undefined labels", () => {
  const device = createDevice();

  const textures = pingPong(device, { size: [1, 1], format: "rgba8unorm", usage: ["copy_src"] });
  const buffers = pingPong(device, { size: 64, usage: ["copy_src"] });

  expect(textures.read.label).toBeUndefined();
  expect(textures.write.label).toBeUndefined();
  expect(buffers.read.options.label).toBeUndefined();
  expect(buffers.write.options.label).toBeUndefined();
});

test("pingPong destroy tears down both current halves and is idempotent", () => {
  const device = createDevice();
  const counts = (device.gpu as GPUDevice & { __destroyCounts: { buffer: number; texture: number } }).__destroyCounts;
  const textures = pingPong(device, { size: [1, 1], format: "rgba8unorm", usage: ["copy_src"] });
  const buffers = pingPong(device, { size: 64, usage: ["copy_src"] });

  const disposeTextures = textures[Symbol.dispose];
  const disposeBuffers = buffers[Symbol.dispose];

  textures.destroy();
  textures.destroy();
  disposeTextures();
  buffers.destroy();
  buffers.destroy();
  disposeBuffers();

  expect(counts.texture).toBe(2);
  expect(counts.buffer).toBe(2);
  expect(() => textures.resize([2, 2])).toThrow("PingPong is destroyed");
  expect(() => buffers.resize(128)).toThrow("PingPong is destroyed");
  expect(counts.texture).toBe(2);
  expect(counts.buffer).toBe(2);
});
