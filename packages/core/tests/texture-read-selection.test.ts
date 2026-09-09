import { expect, test } from "vitest";
import { Device } from "../src/device.ts";
import { createMockGPUDevice, getMockGPUDeviceInstrumentation } from "../src/mock-gpu.ts";
import { Readback } from "../src/readback.ts";
import type { TextureReadOptions, TextureShape } from "../src/types.ts";

const all = { mipLevel: 0, region: "all" } as const;

test.each([
  { kind: "1d", size: [7] },
  { kind: "2d", size: [7, 5] },
  { kind: "2d-array", size: [7, 5], layers: 3 },
  { kind: "3d", size: [7, 5, 5] },
] satisfies TextureShape[])("$kind reads tightly packed crops and every slice at every allocated mip", async (shape) => {
  const device = new Device(createMockGPUDevice());
  const texture = device.createTexture({ ...shape, format: "r32float", usage: ["copy_src", "copy_dst"], mipLevelCount: shape.kind === "1d" ? 1 : 3 });
  try {
    for (let mip = 0; mip < texture.mipLevelCount; mip++) {
      const w = Math.max(1, Math.floor(7 / 2 ** mip));
      const h = shape.kind === "1d" ? 1 : Math.max(1, Math.floor(5 / 2 ** mip));
      const d = shape.kind === "3d" ? Math.max(1, Math.floor(5 / 2 ** mip)) : shape.kind === "2d-array" ? 3 : 1;
      const values = Float32Array.from({ length: w * h * d }, (_, i) => mip * 1000 + i - 5.5);
      device.gpu.queue.writeTexture({ texture: texture.gpu, mipLevel: mip }, values, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h, d]);
      expect(await texture.readFloats({ mipLevel: mip, region: "all" })).toEqual(values);
      const x = w > 1 ? 1 : 0; const y = h > 1 ? 1 : 0; const z = d > 1 ? 1 : 0;
      const expected: number[] = [];
      for (let k = z; k < d; k++) for (let j = y; j < h; j++) for (let i = x; i < w; i++) expected.push(values[(k * h + j) * w + i]!);
      expect(await texture.readFloats({ mipLevel: mip, region: { origin: [x, y, z], size: [w - x, h - y, d - z] } })).toEqual(new Float32Array(expected));
    }
    // Other mip uploads did not alter mip zero.
    expect((await texture.readFloats(all))[0]).toBe(-5.5);
  } finally { texture.destroy(); device.destroy(); }
});

test.each([
  undefined, {}, { mipLevel: 0 }, { region: "all" },
  ...[-1, 0.5, NaN, Infinity, 1, Number.MAX_SAFE_INTEGER].map(mipLevel => ({ mipLevel, region: "all" })),
  ...[
    { origin: [0, 0], size: [1, 1, 1] }, { origin: [0, 0, 0], size: [1, 1] },
    { origin: [-1, 0, 0], size: [1, 1, 1] }, { origin: [0.5, 0, 0], size: [1, 1, 1] },
    { origin: [0, 0, 1], size: [1, 1, 1] }, { origin: [0, 0, 0], size: [0, 1, 1] },
    { origin: [1, 0, 0], size: [2, 1, 1] }, { origin: [0, 0, 0], size: [1, Infinity, 1] },
    { origin: [Number.MAX_SAFE_INTEGER, 0, 0], size: [Number.MAX_SAFE_INTEGER, 1, 1] },
    null, "first",
  ].map(region => ({ mipLevel: 0, region })),
])("rejects invalid selection %j without GPU allocation", async options => {
  const device = new Device(createMockGPUDevice());
  const texture = device.createTexture({ kind: "2d", size: [2, 2], format: "rgba8unorm", usage: ["copy_src"] });
  const instrumentation = getMockGPUDeviceInstrumentation(device.gpu);
  for (const read of [texture.read.bind(texture), texture.readFloats.bind(texture)]) {
    await expect(read(options as TextureReadOptions)).rejects.toMatchObject({ code: "VGPU-CORE-TEXTURE-READ-INVALID" });
  }
  expect(instrumentation.calls.createBuffer).toBe(0);
  expect(instrumentation.calls.createCommandEncoder).toBe(0);
  device.destroy();
});

test("rejects missing copy_src and multisampling before allocating", async () => {
  const device = new Device(createMockGPUDevice());
  for (const sampleCount of [1, 4] as const) {
    const texture = device.createTexture({ kind: "2d", size: [2, 2], format: "rgba8unorm", usage: ["render_attachment"], sampleCount });
    await expect(texture.read(all)).rejects.toMatchObject({ code: "VGPU-CORE-TEXTURE-READ-INVALID" });
  }
  expect(getMockGPUDeviceInstrumentation(device.gpu).calls.createBuffer).toBe(0);
  device.destroy();
});

test("rejects oversized staging allocations before createBuffer", async () => {
  const gpu = createMockGPUDevice();
  const native = { width: 16384, height: 16384, depthOrArrayLayers: 2048, mipLevelCount: 1, dimension: "2d", sampleCount: 1, format: "rgba32float", usage: 1 } as GPUTexture;
  await expect(new Readback(gpu).readTexture(native, all)).rejects.toMatchObject({ code: "VGPU-CORE-TEXTURE-READ-INVALID" });
  expect(getMockGPUDeviceInstrumentation(gpu).calls.createBuffer).toBe(0);
});

test("rejects destruction during a mock read instead of returning stale data", async () => {
  const device = new Device(createMockGPUDevice());
  const texture = device.createTexture({ kind: "2d", size: [2, 2], format: "rgba8unorm", usage: ["copy_src"] });
  const pending = texture.read(all);
  texture.destroy();
  await expect(pending).rejects.toMatchObject({ code: "VGPU-CORE-TEXTURE-DESTROYED" });
  device.destroy();
});

test("readFloats preflights the expanded component allocation", async () => {
  const device = new Device(createMockGPUDevice());
  const texture = device.createTexture({ kind: "2d", size: [100, 1], format: "r8unorm", usage: ["copy_src"] });
  Object.defineProperty(device.gpu, "limits", { value: { ...device.gpu.limits, maxBufferSize: 256 } });
  await expect(texture.read(all)).resolves.toHaveLength(100);
  await expect(texture.readFloats(all)).rejects.toMatchObject({ code: "VGPU-CORE-TEXTURE-READ-INVALID" });
  expect(getMockGPUDeviceInstrumentation(device.gpu).calls.createBuffer).toBe(0);
  device.destroy();
});

test("mock nonzero mip uploads validate bounds and source layout without partial writes", async () => {
  const device = new Device(createMockGPUDevice());
  const texture = device.createTexture({ kind: "3d", size: [6, 4, 4], format: "r8unorm", mipLevelCount: 2, usage: ["copy_src", "copy_dst"] });
  const write = (origin: [number, number, number], data: Uint8Array, extent: [number, number, number]) => device.gpu.queue.writeTexture({ texture: texture.gpu, mipLevel: 1, origin }, data, { bytesPerRow: 3, rowsPerImage: 2 }, extent);
  expect(() => write([0, 0, 2], new Uint8Array(6), [3, 2, 1])).toThrow(/region/);
  expect(() => write([1, 0, 0], new Uint8Array(6), [3, 2, 1])).toThrow(/region/);
  expect(() => write([0, 0, 0], new Uint8Array(5), [3, 2, 1])).toThrow(/layout/);
  expect(await texture.read({ mipLevel: 1, region: "all" })).toEqual(new Uint8Array(12));
  device.destroy();
});
