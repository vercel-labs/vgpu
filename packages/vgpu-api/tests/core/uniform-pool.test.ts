import { expect, test, vi } from "vitest";
import { createMockGPUDevice, Device, VGPUError } from "@vgpu/core";
import { UniformPool, type UniformLayout } from "../../src/core.ts";
const uniformUsage = 64;
const copyDstUsage = 8;
test("allocates a slot with the expected shape", () => {
  const { device, pool } = makePool();
  const slot = pool.alloc(floatLayout());
  expect(slot).toMatchObject({ pool, stride: 256 });
  expect(slot.gpu).toBe(pool.gpu);
  expect(slot.bindGroup).not.toBeNull();
  expect(slot.bindGroupLayout).not.toBeNull();
  device.destroy();
});
test("allocates distinct slots for repeated layouts", () => {
  const { device, pool } = makePool();
  expect(pool.alloc(floatLayout())).not.toBe(pool.alloc(floatLayout()));
  device.destroy();
});
test("push writes encoded bytes into the CPU mirror", () => {
  const { device, pool } = makePool();
  expect(pool.alloc(floatLayout()).push(42)).toBe(0);
  expect(new DataView(pool.cpuMirror).getFloat32(0, true)).toBe(42);
  expect(pool.usedBytes).toBe(256);
  device.destroy();
});
test("beginFrame resets frame-local writes after endFrame", () => {
  const { device, pool } = makePool();
  const slot = pool.alloc(floatLayout());
  slot.push(1); pool.endFrame(); pool.beginFrame(1);
  expect(slot.push(2)).toBe(0);
  expect(pool.usedBytes).toBe(256);
  expect(new DataView(pool.cpuMirror).getFloat32(0, true)).toBe(2);
  device.destroy();
});
test("push after endFrame can be flushed by the next endFrame", () => {
  const { device, pool } = makePool(768);
  const slot = pool.alloc(floatLayout());
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");
  slot.push(1); pool.endFrame(); expect(slot.push(2)).toBe(256); pool.endFrame();
  expect(writeBuffer).toHaveBeenCalledTimes(2);
  device.destroy();
});
test("throws when pushes exceed capacity", () => {
  const { device, pool } = makePool(256);
  const slot = pool.alloc(floatLayout());
  slot.push(1);
  expect(() => slot.push(2)).toThrow(/capacity/);
  expectInvalidCode(() => slot.push(2), "VGPU-UNIFORM-POOL-OVERFLOW");
  device.destroy();
});
test("throws when a layout cannot fit in one binding", () => {
  const { device, pool } = makePool(512, { maxUniformBufferBindingSize: 256 });
  expect(() => pool.alloc(bytesLayout(300))).toThrow(/layout/);
  expectInvalidCode(() => pool.alloc(bytesLayout(300)), "VGPU-UNIFORM-LAYOUT-OVERSIZED");
  device.destroy();
});
test("dispose releases the backing buffer", () => {
  let destroyed = false;
  const { device, pool } = makePool(512, {}, (buffer) => {
    const destroy = buffer.destroy.bind(buffer);
    Object.defineProperty(buffer, "destroy", { value: () => { destroyed = true; destroy(); } });
    return buffer;
  });
  pool.dispose();
  expect(pool.disposed).toBe(true);
  expect(destroyed).toBe(true);
  device.destroy();
});
test("rejects a slot allocated by a different pool", () => {
  const { device, pool } = makePool();
  const slot = new UniformPool(device, { capacityBytes: 512 }).alloc(floatLayout());
  expectInvalidCode(() => pool.push(slot, 1), "VGPU-CORE-INVALID-USAGE");
  expectInvalidCode(() => pool.pushBytes(slot, new Float32Array([1])), "VGPU-CORE-INVALID-USAGE");
  device.destroy();
});
test("alloc creates a GPUBuffer with UNIFORM and COPY_DST usage", () => {
  let descriptor: GPUBufferDescriptor | undefined;
  const { device, pool } = makePool(512, {}, undefined, (desc) => { descriptor = desc; });
  expect(pool.alloc(floatLayout()).gpu).toBe(pool.gpu);
  expect(descriptor?.usage).toBe(uniformUsage | copyDstUsage);
  device.destroy();
});
test("alloc creates a stable bind group and bind group layout", () => {
  const { device, pool } = makePool();
  const slot = pool.alloc(floatLayout());
  expect(slot.bindGroup).toBe(slot.bindGroup);
  expect(slot.bindGroupLayout).toBe(slot.bindGroupLayout);
  device.destroy();
});
test("alloc with provided bindGroupLayout reuses it", () => {
  const { device, pool } = makePool();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");
  const bindGroupLayout = {} as GPUBindGroupLayout;
  expect(pool.alloc({ ...floatLayout(), bindGroupLayout }).bindGroupLayout).toBe(bindGroupLayout);
  expect(createBindGroupLayout).not.toHaveBeenCalled();
  device.destroy();
});
test("endFrame uploads CPU mirror via queue.writeBuffer", () => {
  const { device, pool } = makePool();
  const slot = pool.alloc(floatLayout());
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");
  slot.push(1); pool.endFrame();
  expect(writeBuffer).toHaveBeenCalledWith(slot.gpu, 0, pool.cpuMirror, 0, 256);
  device.destroy();
});
test("endFrame on a clean pool is a no-op", () => {
  const { device, pool } = makePool();
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");
  pool.beginFrame(0); pool.endFrame();
  expect(writeBuffer).not.toHaveBeenCalled();
  device.destroy();
});
test("assertReadyForSubmit throws when there are unflushed pushes", () => {
  const { device, pool } = makePool();
  pool.alloc(floatLayout()).push(1);
  expectInvalidCode(() => pool.assertReadyForSubmit("test"), "VGPU-CORE-INVALID-USAGE");
  expect(() => pool.assertReadyForSubmit("test")).toThrow(/VGPU-CORE-INVALID-USAGE|unflushed pushes/);
  device.destroy();
});
test("assertReadyForSubmit is a no-op after endFrame", () => {
  const { device, pool } = makePool();
  pool.alloc(floatLayout()).push(1); pool.endFrame();
  expect(() => pool.assertReadyForSubmit("test")).not.toThrow();
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
  try { action(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(VGPUError);
  expect(thrown).toMatchObject({ code });
}
function makePool(capacityBytes = 512, limits: Partial<Record<keyof GPUSupportedLimits, number>> = {}, createBuffer?: (buffer: GPUBuffer) => GPUBuffer, onCreateBuffer?: (desc: GPUBufferDescriptor) => void) {
  const base = createMockGPUDevice();
  const gpu = { ...base, limits, createBuffer: (desc: GPUBufferDescriptor) => {
    onCreateBuffer?.(desc);
    return createBuffer?.(base.createBuffer(desc)) ?? base.createBuffer(desc);
  } } as unknown as GPUDevice;
  const device = new Device(gpu, null);
  return { device, pool: new UniformPool(device, { capacityBytes }) };
}
