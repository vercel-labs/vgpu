import { expect, test } from "vitest";
import { Device } from "../src/device.ts";
import { createMockGPUDevice } from "../src/mock-gpu.ts";
import { decodeTextureFloats } from "../src/readback.ts";
import type { Texture } from "../src/texture.ts";

/**
 * Format coverage for Texture.read()/readFloats() on the mock adapter: the mock stores real
 * per-format texel bytes, so queue.writeTexture + read() is a genuine round-trip per format.
 */
function mockDevice(): Device {
  return new Device(createMockGPUDevice(), null);
}

function createTexture(device: Device, format: GPUTextureFormat, size: readonly [number, number]): Texture {
  return device.createTexture({ size, format, usage: ["render_attachment", "copy_src", "copy_dst"] });
}

function writeTexture(device: Device, texture: Texture, data: BufferSource, bytesPerRow: number, size: readonly [number, number]): void {
  device.gpu.queue.writeTexture({ texture: texture.gpu }, data, { bytesPerRow }, { width: size[0], height: size[1] });
}

/** IEEE-754 binary16 encoder for zero and normal values, enough to author expected f16 texel bytes. */
function halfBits(value: number): number {
  if (value === 0) return Object.is(value, -0) ? 0x8000 : 0;
  const f32 = new Float32Array([value]);
  const bits = new Uint32Array(f32.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = (bits >>> 13) & 0x3ff;
  return sign | (exponent << 10) | mantissa;
}

test("rgba8unorm read() keeps returning the exact bytes (unchanged behavior)", async () => {
  const device = mockDevice();
  const texture = createTexture(device, "rgba8unorm", [2, 2]);
  const bytes = new Uint8Array(2 * 2 * 4).map((_, i) => i * 3);

  writeTexture(device, texture, bytes, 2 * 4, [2, 2]);
  const read = await texture.read();

  expect(read.byteLength).toBe(2 * 2 * 4);
  expect([...read]).toEqual([...bytes]);
  // readFloats() normalizes the same bytes to [0, 1].
  expect([...(await texture.readFloats())]).toEqual([...bytes].map((b) => Math.fround(b / 255)));
  device.destroy();
});

test("rgba32float round-trips HDR values through readFloats()", async () => {
  const device = mockDevice();
  const texture = createTexture(device, "rgba32float", [2, 1]);
  const values = new Float32Array([12.5, -3.25, 1000.75, 1, 0.125, 0, -0.5, 65504]);

  writeTexture(device, texture, values, 2 * 16, [2, 1]);

  // read() stays raw bytes: 16 bytes per texel, no clamping to 0..255.
  expect((await texture.read()).byteLength).toBe(2 * 1 * 16);
  expect([...(await texture.readFloats())]).toEqual([...values]);
  device.destroy();
});

test("rgba16float round-trips half-float values through readFloats()", async () => {
  const device = mockDevice();
  const texture = createTexture(device, "rgba16float", [2, 1]);
  const values = [2.5, -1.5, 0.25, 1, 100, 0, -0.125, 64];
  const halves = Uint16Array.from(values, halfBits);

  writeTexture(device, texture, halves, 2 * 8, [2, 1]);

  expect((await texture.read()).byteLength).toBe(2 * 1 * 8);
  expect([...(await texture.readFloats())]).toEqual(values);
  device.destroy();
});

test("single-channel formats read back one component per texel", async () => {
  const device = mockDevice();

  const r32 = createTexture(device, "r32float", [3, 1]);
  writeTexture(device, r32, new Float32Array([0.5, -2, 1024]), 3 * 4, [3, 1]);
  expect([...(await r32.readFloats())]).toEqual([0.5, -2, 1024]);

  const r16 = createTexture(device, "r16float", [3, 1]);
  writeTexture(device, r16, Uint16Array.from([0.5, -2, 1024], halfBits), 3 * 2, [3, 1]);
  expect([...(await r16.readFloats())]).toEqual([0.5, -2, 1024]);

  const r8 = createTexture(device, "r8unorm", [3, 1]);
  writeTexture(device, r8, new Uint8Array([0, 128, 255]), 3, [3, 1]);
  expect((await r8.read()).byteLength).toBe(3);
  expect([...(await r8.readFloats())]).toEqual([0, Math.fround(128 / 255), 1]);

  device.destroy();
});

test("rg formats read back two components per texel", async () => {
  const device = mockDevice();

  const rg32 = createTexture(device, "rg32float", [2, 1]);
  writeTexture(device, rg32, new Float32Array([1.5, -1.5, 3, 4]), 2 * 8, [2, 1]);
  expect([...(await rg32.readFloats())]).toEqual([1.5, -1.5, 3, 4]);

  const rg16 = createTexture(device, "rg16float", [2, 1]);
  writeTexture(device, rg16, Uint16Array.from([1.5, -1.5, 3, 4], halfBits), 2 * 4, [2, 1]);
  expect([...(await rg16.readFloats())]).toEqual([1.5, -1.5, 3, 4]);

  device.destroy();
});

test("readFloats() rejects formats that have no readback layout", async () => {
  const device = mockDevice();
  const depth = createTexture(device, "depth24plus", [1, 1]);

  await expect(depth.readFloats()).rejects.toMatchObject({ code: "VGPU-CORE-UNSUPPORTED-FORMAT" });
  device.destroy();
});

test("readFloats() throws on a destroyed texture instead of decoding stale bytes", async () => {
  const device = mockDevice();
  const texture = createTexture(device, "rgba16float", [1, 1]);
  texture.destroy();

  await expect(texture.readFloats()).rejects.toMatchObject({ code: "VGPU-CORE-TEXTURE-DESTROYED" });
  device.destroy();
});

test("decodeTextureFloats() widens f16 subnormals, infinities, and NaN", () => {
  const bits = new Uint16Array([
    0x0001, // smallest positive subnormal: 2^-24
    0x8000, // -0
    0x7c00, // +Infinity
    0xfc00, // -Infinity
    0x7e00, // NaN
  ]);
  const decoded = decodeTextureFloats(new Uint8Array(bits.buffer), "r16float");

  expect(decoded[0]).toBeCloseTo(2 ** -24, 30);
  expect(Object.is(decoded[1], -0)).toBe(true);
  expect(decoded[2]).toBe(Number.POSITIVE_INFINITY);
  expect(decoded[3]).toBe(Number.NEGATIVE_INFINITY);
  expect(Number.isNaN(decoded[4])).toBe(true);
});

test("decodeTextureFloats() reads unaligned byte views (readback slices are not 4-byte aligned)", () => {
  const backing = new Uint8Array(4 + 8);
  new DataView(backing.buffer).setFloat32(1, 2.5, true);
  new DataView(backing.buffer).setFloat32(5, -7.25, true);

  const decoded = decodeTextureFloats(backing.subarray(1, 9), "r32float");

  expect([...decoded]).toEqual([2.5, -7.25]);
});
