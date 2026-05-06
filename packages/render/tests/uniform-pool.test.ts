import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";
import { UniformPool, type UniformLayout } from "@vgpu/render";

test("allocates a slot with the expected shape", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512, minOffsetAlignment: 256 });

  const slot = pool.alloc(floatLayout());

  expect(slot).toMatchObject({ pool, stride: 256, bindGroup: null, bindGroupLayout: null });
  expect(slot.gpu).toBe(pool.gpu);
  device.destroy();
});

test("allocates distinct slots for repeated layouts", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512, minOffsetAlignment: 256 });

  expect(pool.alloc(floatLayout())).not.toBe(pool.alloc(floatLayout()));
  device.destroy();
});

test("push writes encoded bytes into the CPU mirror", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512, minOffsetAlignment: 256 });
  const slot = pool.alloc(floatLayout());

  const offset = slot.push(42);

  expect(offset).toBe(0);
  expect(new DataView(pool.cpuMirror).getFloat32(0, true)).toBe(42);
  expect(pool.usedBytes).toBe(256);
  device.destroy();
});

test("beginFrame resets frame-local writes after endFrame", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512, minOffsetAlignment: 256 });
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
  const pool = new UniformPool(device, { capacityBytes: 512, minOffsetAlignment: 256 });
  const slot = pool.alloc(floatLayout());
  pool.endFrame();

  expect(() => slot.push(1)).toThrow(/beginFrame/);
  try {
    slot.push(1);
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-CORE-UNIFORM-POOL-PUSH-AFTER-FLUSH" });
  }
  device.destroy();
});

test("throws when pushes exceed capacity", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 256, minOffsetAlignment: 256 });
  const slot = pool.alloc(floatLayout());
  slot.push(1);

  expect(() => slot.push(2)).toThrow(/capacity/);
  try {
    slot.push(2);
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-UNIFORM-POOL-OVERFLOW" });
  }
  device.destroy();
});

test("throws when a layout cannot fit in one binding", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512, maxUniformBindingSize: 256 });

  expect(() => pool.alloc(bytesLayout(300))).toThrow(/layout/);
  try {
    pool.alloc(bytesLayout(300));
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-UNIFORM-LAYOUT-OVERSIZED" });
  }
  device.destroy();
});

test("dispose releases the backing buffer", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const pool = new UniformPool(device, { capacityBytes: 512 });

  pool.dispose();

  expect(pool.disposed).toBe(true);
  device.destroy();
});

function floatLayout(): UniformLayout<number> {
  return {
    size: 4,
    encode(value, dst, byteOffset) {
      new DataView(dst).setFloat32(byteOffset, value, true);
    },
  };
}

function bytesLayout(size: number): UniformLayout<Uint8Array> {
  return { size, encode: (value, dst, byteOffset) => new Uint8Array(dst, byteOffset, value.byteLength).set(value) };
}
