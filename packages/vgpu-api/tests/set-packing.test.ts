import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { expect, test } from "vitest";
import { drawBindingState } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import { effect, init } from "../src/mock.ts";
import { writeLayoutValue } from "../src/set-packing.ts";

test("f16 packing follows IEEE binary16 round-to-nearest, ties-to-even", () => {
  const layout = requiredLayout("enable f16; @group(0) @binding(0) var<storage, read> value: f16;");
  const probes = [
    [0x00000000, 0x0000],
    [0x80000000, 0x8000],
    [0x3f800000, 0x3c00],
    [0x3f801000, 0x3c00],
    [0x3f803000, 0x3c02],
    [0x3f801800, 0x3c01],
    [0x33000000, 0x0000],
    [0x33000001, 0x0001],
    [0x33c00000, 0x0002],
    [0x33800000, 0x0001],
    [0x477fe000, 0x7bff],
    [0x477ff000, 0x7c00],
    [0x7f800000, 0x7c00],
    [0xff800000, 0xfc00],
  ] as const;

  for (const [inputBits, expectedBits] of probes) {
    expect(packedF16Bits(layout, float32FromBits(inputBits))).toBe(expectedBits);
  }
  expect(packedF16Bits(layout, float32FromBits(0x7fc12345)) & 0x7e00).toBe(0x7e00);
});

test("packing rejects an inexact vector shape at its complete value path", () => {
  const layout = requiredLayout(`
    struct Params { a: f32, b: vec3f }
    @group(0) @binding(0) var<storage, read> params: Params;
  `);

  expect(() => writeLayoutValue(layout, { a: 1, b: [2, 3] })).toThrowError(
    expect.objectContaining({
      code: "VGPU-SET-VALUE-INVALID",
      detail: { reason: "shape", path: "$.b", expected: 3, actual: 2 },
    }),
  );
});

test.each([
  ["missing struct field", { vector: [1, 2, 3], items: [4, 5], signed: -1, unsigned: 2 }, "missing-field", "$.matrix"],
  ["unknown struct field", { vector: [1, 2, 3], matrix: [1, 2, 3, 4], items: [4, 5], signed: -1, unsigned: 2, extra: 0 }, "unknown-field", "$.extra"],
  ["short matrix", { vector: [1, 2, 3], matrix: [1, 2, 3], items: [4, 5], signed: -1, unsigned: 2 }, "shape", "$.matrix"],
  ["long fixed array", { vector: [1, 2, 3], matrix: [1, 2, 3, 4], items: [4, 5, 6], signed: -1, unsigned: 2 }, "shape", "$.items"],
  ["fractional i32", { vector: [1, 2, 3], matrix: [1, 2, 3, 4], items: [4, 5], signed: 1.5, unsigned: 2 }, "integer-range", "$.signed"],
  ["negative u32", { vector: [1, 2, 3], matrix: [1, 2, 3, 4], items: [4, 5], signed: -1, unsigned: -1 }, "integer-range", "$.unsigned"],
] as const)("packing rejects %s before writing", (_name, value, reason, path) => {
  const layout = requiredLayout(`
    struct Params {
      vector: vec3f,
      matrix: mat2x2f,
      items: array<u32, 2>,
      signed: i32,
      unsigned: u32,
    }
    @group(0) @binding(0) var<storage, read> params: Params;
  `);

  expectPackingError(() => writeLayoutValue(layout, value), reason, path);
});

test("packing rejects a projected runtime array whose byte extent does not match its count", () => {
  const layout = requiredLayout("@group(0) @binding(0) var<storage, read> values: array<vec2f>;");
  const projected = { ...layout, size: layout.stride! * 2 - 1 };

  expectPackingError(() => writeLayoutValue(projected, [[1, 2], [3, 4]]), "extent", "$");
});

test("a rejected set leaves both GPU bytes and the previous partial-update base unchanged", async () => {
  const gpu = await init();
  const shader = `
    struct Params { head: u32, values: vec2u }
    @group(0) @binding(0) var<uniform> params: Params;
    @fragment fn main() -> @location(0) vec4f { return vec4f(f32(params.head)); }
  `;
  const fx = effect(gpu, shader, { set: { params: { head: 1, values: [2, 3] } } });
  const buffer = (drawBindingState(effectDraw(fx), "params")?.resource as GPUBufferBinding).buffer;
  if (!("__vgpuMockBytes" in buffer)) throw new Error("fixture did not expose mock buffer bytes");
  const before = buffer.__vgpuMockBytes.slice();

  expectPackingError(() => fx.set({ params: { head: 9, values: [10] } }), "shape", "$.values");
  expect(buffer.__vgpuMockBytes).toEqual(before);

  fx.set({ params: { head: 4 } });
  const view = new DataView(buffer.__vgpuMockBytes.buffer, buffer.__vgpuMockBytes.byteOffset, buffer.__vgpuMockBytes.byteLength);
  expect([view.getUint32(0, true), view.getUint32(8, true), view.getUint32(12, true)]).toEqual([4, 2, 3]);
  gpu.dispose();
});

test("a rejected first JS value does not latch binding ownership", async () => {
  const gpu = await init();
  const fx = effect(gpu, `
    @group(0) @binding(0) var<uniform> params: vec2u;
    @fragment fn main() -> @location(0) vec4f { return vec4f(f32(params.x)); }
  `);
  const userBuffer = gpu.device.createBuffer({ size: 8, usage: ["uniform", "copy_dst"] });

  expectPackingError(() => fx.set({ params: [1] }), "shape", "$");
  expect(() => fx.set({ params: userBuffer })).not.toThrow();
  gpu.dispose();
});

test("the first direct struct value is complete while member shorthand starts from reflected zero", async () => {
  const gpu = await init();
  const fx = effect(gpu, `
    struct Params { head: u32, values: vec2u }
    @group(0) @binding(0) var<uniform> params: Params;
    @fragment fn main() -> @location(0) vec4f { return vec4f(f32(params.head)); }
  `);

  expectPackingError(() => fx.set({ params: { head: 7 } }), "missing-field", "$.values");
  fx.set({ head: 7 });

  const buffer = (drawBindingState(effectDraw(fx), "params")?.resource as GPUBufferBinding).buffer;
  if (!("__vgpuMockBytes" in buffer)) throw new Error("fixture did not expose mock buffer bytes");
  const view = new DataView(buffer.__vgpuMockBytes.buffer, buffer.__vgpuMockBytes.byteOffset, buffer.__vgpuMockBytes.byteLength);
  expect([view.getUint32(0, true), view.getUint32(8, true), view.getUint32(12, true)]).toEqual([7, 0, 0]);
  gpu.dispose();
});

function requiredLayout(wgsl: string) {
  const layout = reflectSource(wgsl).bindings[0]?.layout;
  if (!layout) throw new Error("fixture did not reflect a host-shareable layout");
  return layout;
}

function packedF16Bits(layout: ReturnType<typeof requiredLayout>, value: number): number {
  return new DataView(writeLayoutValue(layout, value)).getUint16(0, true);
}

function float32FromBits(bits: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}

function expectPackingError(operation: () => unknown, reason: string, path: string): void {
  try {
    operation();
    throw new Error("expected packing to fail");
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-SET-VALUE-INVALID", detail: { reason, path } });
  }
}
