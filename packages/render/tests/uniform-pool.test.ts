import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, createMockGPUDevice, Device, VGPUError } from "@vgpu/core";
import { UniformPool, type UniformLayout } from "@vgpu/render";

test("allocates a slot with the expected shape", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512 });
  const slot = pool.alloc(floatLayout());
  expect(slot).toMatchObject({ pool, stride: 256, bindGroup: null, bindGroupLayout: null });
  expect(slot.gpu).toBe(pool.gpu);
  device.destroy();
});

test("allocates distinct slots for repeated layouts", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512 });
  expect(pool.alloc(floatLayout())).not.toBe(pool.alloc(floatLayout()));
  device.destroy();
});

test("push writes encoded bytes into the CPU mirror", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512 });
  const slot = pool.alloc(floatLayout());
  const offset = slot.push(42);
  expect(offset).toBe(0);
  expect(new DataView(pool.cpuMirror).getFloat32(0, true)).toBe(42);
  expect(pool.usedBytes).toBe(256);
  device.destroy();
});

test("beginFrame resets frame-local writes after endFrame", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512 });
  const slot = pool.alloc(floatLayout());
  slot.push(1);
  pool.endFrame();
  pool.beginFrame(1);
  const offset = slot.push(2);
  expect(offset).toBe(0);
  expect(pool.usedBytes).toBe(256);
  expect(new DataView(pool.cpuMirror).getFloat32(0, true)).toBe(2);
  device.destroy();
});

test("throws when pushing after endFrame before the next beginFrame", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512 });
  const slot = pool.alloc(floatLayout());
  pool.endFrame();
  expect(() => slot.push(1)).toThrow(/beginFrame/);
  expectInvalidCode(() => slot.push(1), "VGPU-CORE-UNIFORM-POOL-PUSH-AFTER-FLUSH");
  device.destroy();
});

test("throws when pushes exceed capacity", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 256 });
  const slot = pool.alloc(floatLayout());
  slot.push(1);
  expect(() => slot.push(2)).toThrow(/capacity/);
  expectInvalidCode(() => slot.push(2), "VGPU-UNIFORM-POOL-OVERFLOW");
  device.destroy();
});

test("throws when a layout cannot fit in one binding", () => {
  const device = createDevice({ maxUniformBufferBindingSize: 256 });
  const pool = new UniformPool(device, { capacityBytes: 512 });
  expect(() => pool.alloc(bytesLayout(300))).toThrow(/layout/);
  expectInvalidCode(() => pool.alloc(bytesLayout(300)), "VGPU-UNIFORM-LAYOUT-OVERSIZED");
  device.destroy();
});

test("dispose releases the backing buffer", () => {
  let destroyed = false;
  const device = createDevice({}, (buffer) => {
    const destroy = buffer.destroy.bind(buffer);
    Object.defineProperty(buffer, "destroy", { value: () => { destroyed = true; destroy(); } });
    return buffer;
  });
  const pool = new UniformPool(device, { capacityBytes: 512 });
  pool.dispose();
  expect(pool.disposed).toBe(true);
  expect(destroyed).toBe(true);
  device.destroy();
});

test("rejects a slot allocated by a different pool", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const poolA = new UniformPool(device, { capacityBytes: 512 });
  const poolB = new UniformPool(device, { capacityBytes: 512 });
  const slot = poolB.alloc(floatLayout());
  expectInvalidCode(() => poolA.push(slot, 1), "VGPU-CORE-INVALID-USAGE");
  expectInvalidCode(() => poolA.pushBytes(slot, new Float32Array([1])), "VGPU-CORE-INVALID-USAGE");
  device.destroy();
});

function floatLayout(): UniformLayout<number> {
  return { size: 4, encode: (value, dst, byteOffset) => new DataView(dst).setFloat32(byteOffset, value, true) };
}

function bytesLayout(size: number): UniformLayout<Uint8Array> {
  return { size, encode: (value, dst, byteOffset) => new Uint8Array(dst, byteOffset, value.byteLength).set(value) };
}

function expectInvalidCode(action: () => void, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(VGPUError);
  expect(thrown).toMatchObject({ code });
}

function createDevice(
  limits: Partial<Record<keyof GPUSupportedLimits, number>>,
  createBuffer?: (buffer: GPUBuffer) => GPUBuffer,
): Device {
  const base = createMockGPUDevice();
  const gpu = {
    ...base,
    limits,
    createBuffer: (descriptor: GPUBufferDescriptor) => createBuffer?.(base.createBuffer(descriptor)) ?? base.createBuffer(descriptor),
  } as unknown as GPUDevice;
  return new Device(gpu, null);
}
