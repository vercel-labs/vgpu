import { afterEach, describe, expect, test, vi } from "vitest";
import { bundle, compute, effect, frame, getMockGPUDeviceInstrumentation, init, target } from "../src/mock.ts";
import { identityKey } from "../src/bind-cache.ts";
import { drawBindingState } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import { isPlainObject, isPlainValue } from "../src/set-resources.ts";

type Gpu = Awaited<ReturnType<typeof init>>;

const UNIFORM = "struct P { value: vec4f } @group(0) @binding(0) var<uniform> p: P; @fragment fn main() -> @location(0) vec4f { return p.value; }";
const STORAGE = "struct P { value: vec4f } @group(0) @binding(0) var<storage, read> p: P; @compute @workgroup_size(1) fn main() { let x = p.value; }";
const FIELDS = "struct S { buffer: f32, offset: f32, size: f32 } @group(0) @binding(0) var<uniform> s: S; @fragment fn main() -> @location(0) vec4f { return vec4f(s.buffer, s.offset, s.size, 1); }";
const NESTED = "struct Inner { x: f32 } struct S { buffer: Inner, values: vec4f } @group(0) @binding(0) var<uniform> s: S; @fragment fn main() -> @location(0) vec4f { return s.values + vec4f(s.buffer.x); }";
afterEach(() => vi.restoreAllMocks());

const uniformBuffer = (gpu: Gpu) => gpu.gpu.createBuffer({ size: 512, usage: 0x40 | 0x08 });

function setup(gpu: Gpu, value: unknown) {
  const fx = effect(gpu, UNIFORM, { set: { p: value } });
  const color = target(gpu, { size: [1, 1] });
  const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
  const descriptors = () => mock.createBindGroupDescriptors.map(desc => [...desc.entries][0]!.resource as GPUBufferBinding);
  return { fx, color, descriptors, state: () => drawBindingState(effectDraw(fx), "p")! };
}

describe("raw GPUBuffer and GPUBufferBinding values", () => {
  test("a raw GPUBuffer binds as a user-owned resource and is never captured", async () => {
    const gpu = await init();
    try {
      const buffer = uniformBuffer(gpu);
      const { fx, color, descriptors, state } = setup(gpu, buffer);
      expect(state().ownership).toBe("user");
      fx.draw(color);
      await frame(gpu, f => f.pass(color, fx)).done;
      expect(descriptors()).toEqual([{ buffer }]);
    } finally { gpu.dispose(); }
  });

  test("a buffer range binds its offset and size, and a different range is a different bind group", async () => {
    const gpu = await init();
    try {
      const buffer = uniformBuffer(gpu);
      const range = { buffer, offset: 256, size: 16 };
      const { fx, color, descriptors } = setup(gpu, range);
      fx.draw(color);
      fx.set({ p: { buffer, offset: 256, size: 16 } });
      fx.draw(color);
      range.offset = 0;
      fx.draw(color);
      expect(descriptors()).toEqual([{ buffer, offset: 256, size: 16 }]);
      fx.set({ p: { buffer, offset: 0, size: 16 } });
      fx.draw(color);
      fx.set({ p: { buffer, offset: 0, size: 32 } });
      fx.draw(color);
      expect(descriptors()).toEqual([{ buffer, offset: 256, size: 16 }, { buffer, offset: 0, size: 16 }, { buffer, offset: 0, size: 32 }]);
    } finally { gpu.dispose(); }
  });

  test("equivalent descriptors of the whole buffer share one identity and bind group", async () => {
    const gpu = await init();
    try {
      const buffer = uniformBuffer(gpu);
      const { fx, color, descriptors, state } = setup(gpu, buffer);
      const keys: string[] = [];
      for (const value of [buffer, { buffer }, { buffer, offset: 0 }, { buffer, offset: 0, size: buffer.size }]) {
        fx.set({ p: value });
        keys.push(identityKey(state().identity));
        fx.draw(color);
      }
      expect(new Set(keys).size).toBe(1);
      expect(descriptors()).toHaveLength(1);
    } finally { gpu.dispose(); }
  });

  test("a recorded bundle goes stale when the bound range changes", async () => {
    const gpu = await init();
    try {
      const buffer = uniformBuffer(gpu);
      const { fx, color } = setup(gpu, { buffer, offset: 0 });
      const recorded = bundle(gpu, { target: color }, p => p.draw(fx));
      fx.set({ p: { buffer, offset: 0, size: buffer.size } });
      expect(() => frame(gpu, f => f.pass(color, p => p.bundles(recorded)))).not.toThrow();
      fx.set({ p: { buffer, offset: 256 } });
      expect(() => frame(gpu, f => f.pass(color, p => p.bundles(recorded)))).toThrowError(expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }));
    } finally { gpu.dispose(); }
  });

  test("raw buffers bind to storage bindings as user-owned resources", async () => {
    const gpu = await init();
    try {
      const buffer = gpu.gpu.createBuffer({ size: 512, usage: 0x80 | 0x08 });
      const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
      const sim = compute(gpu, STORAGE, { set: { p: { buffer, offset: 256, size: 16 } } });
      sim.dispatch(1);
      expect(writes).not.toHaveBeenCalled();
      const resource = [...getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors[0]!.entries][0]!.resource;
      expect(resource).toEqual({ buffer, offset: 256, size: 16 });
    } finally { gpu.dispose(); }
  });

  test("a struct member cannot take a raw buffer", async () => {
    const gpu = await init();
    try {
      const fx = effect(gpu, UNIFORM);
      expect(() => fx.set({ value: uniformBuffer(gpu) })).toThrow(/Member 'value' needs a JS value; set resource 'p' instead/);
    } finally { gpu.dispose(); }
  });
});

describe("structs with a buffer-named field stay plain values", () => {
  test("numeric and nested buffer fields pack as struct members", async () => {
    const gpu = await init();
    try {
      const color = target(gpu, { size: [1, 1] });
      const fields = effect(gpu, FIELDS, { set: { s: { buffer: 1, offset: 2, size: 3 } } });
      const nested = effect(gpu, NESTED, { set: { s: { buffer: { x: 1 }, values: [1, 2, 3, 4] } } });
      expect(drawBindingState(effectDraw(fields), "s")!.ownership).toBe("lib");
      expect(drawBindingState(effectDraw(nested), "s")!.ownership).toBe("lib");
      const descriptors = getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors;
      await frame(gpu, f => { f.pass(color, fields); f.pass(color, nested); }).done;
      const binding = [...descriptors[0]!.entries][0]!.resource as GPUBufferBinding;
      expect(binding.buffer.label).toBe("vgpu.frame.uniforms");
      const bytes = (binding.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
      expect([...new Float32Array(bytes.buffer, binding.offset, 3)]).toEqual([1, 2, 3]);
    } finally { gpu.dispose(); }
  });

  test("classification puts raw buffers before plain values", async () => {
    const gpu = await init();
    try {
      const buffer = uniformBuffer(gpu);
      for (const value of [buffer, { buffer }, { buffer, offset: 0, size: 16 }]) {
        expect(isPlainValue(value)).toBe(false);
        expect(isPlainObject(value)).toBe(false);
      }
      for (const value of [{ buffer: 1 }, { buffer: {}, offset: 1 }, { buffer: [1, 2] }]) {
        expect(isPlainValue(value)).toBe(true);
        expect(isPlainObject(value)).toBe(true);
      }
      for (const value of [new Float32Array(4), new ArrayBuffer(4), [1, 2]]) expect(isPlainValue(value)).toBe(true);
    } finally { gpu.dispose(); }
  });
});
