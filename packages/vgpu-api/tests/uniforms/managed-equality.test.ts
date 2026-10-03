import { afterEach, describe, expect, test, vi } from "vitest";
import { bundle, compute, effect, frame, init, target, uniforms, type Frame } from "../../src/mock.ts";
import { bytesEqual } from "../../src/bytes-equal.ts";
import { FrameUniforms, type UniformValue } from "../../src/frame-uniforms.ts";

type Gpu = Awaited<ReturnType<typeof init>>;

const DECL = "struct Params { value:f32, @align(16) tail:vec4f } @group(0) @binding(0) var<uniform> params:Params;";
const FRAGMENT = `${DECL} @fragment fn main() -> @location(0) vec4f { return vec4f(params.value) + params.tail; }`;
const STORAGE = "struct Params { value:f32 } @group(0) @binding(0) var<storage, read> params:Params; @compute @workgroup_size(1) fn main() { let x = params.value; }";
afterEach(() => vi.restoreAllMocks());

/** Records the buffer range behind every bind group set on a pass, in encode order. */
function recordRanges(gpu: Gpu) {
  const native = gpu.gpu;
  const descriptors = new Map<GPUBindGroup, GPUBindGroupDescriptor>();
  let bound: GPUBindGroup[] = [];
  const createBindGroup = native.createBindGroup.bind(native);
  native.createBindGroup = (desc) => { const bindGroup = createBindGroup(desc); descriptors.set(bindGroup, desc); return bindGroup; };
  const createCommandEncoder = native.createCommandEncoder.bind(native);
  native.createCommandEncoder = (desc) => {
    const encoder = createCommandEncoder(desc);
    for (const key of ["beginRenderPass", "beginComputePass"] as const) {
      const begin = (encoder[key] as (d: unknown) => GPURenderPassEncoder).bind(encoder);
      (encoder as unknown as Record<string, unknown>)[key] = (d: unknown) => {
        const pass = begin(d);
        pass.setBindGroup = ((_: number, bindGroup: GPUBindGroup) => { bound.push(bindGroup); }) as GPURenderPassEncoder["setBindGroup"];
        return pass;
      };
    }
    return encoder;
  };
  return () => {
    const ranges = bound.map(bindGroup => {
      const resource = [...descriptors.get(bindGroup)!.entries][0]!.resource as GPUBufferBinding;
      const bytes = (resource.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
      const offset = resource.offset ?? 0;
      return { buffer: resource.buffer, offset, value: new DataView(bytes.buffer, bytes.byteOffset).getFloat32(offset, true), bytes: bytes.slice(offset, offset + 32) };
    });
    bound = [];
    return ranges;
  };
}

function setup(gpu: Gpu, ownership: "owned" | "shared", initial: Record<string, unknown> = { value: 1 }) {
  const shared = ownership === "shared" ? uniforms(gpu, { tail: [0, 0, 0, 0], ...initial }) : undefined;
  const fx = effect(gpu, FRAGMENT, { set: { params: shared ?? { tail: [0, 0, 0, 0], ...initial } } });
  const set = (values: Record<string, unknown>) => { if (shared) shared.set(values); else fx.set({ params: values }); };
  const color = target(gpu, { size: [1, 1] });
  return { fx, set, shared, color, pass: (f: Frame) => f.pass(color, fx) };
}

function stableWrites(gpu: Gpu) {
  const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
  return () => writes.mock.calls.filter(call => call[0].label !== "vgpu.frame.uniforms").length;
}

test("bytesEqual compares bytes, including views and lengths", () => {
  const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  expect(bytesEqual(a, a.slice())).toBe(true);
  expect(bytesEqual(a, new Uint8Array([1, 2, 3, 4, 5, 6, 8]))).toBe(false);
  expect(bytesEqual(a, a.subarray(0, 6))).toBe(false);
  expect(bytesEqual(new Uint8Array([9, 1, 2, 3, 4, 5, 6, 7]).subarray(1), a)).toBe(true);
  expect(bytesEqual(new Float32Array([1, 2]).buffer, new Float32Array([1, 2]).buffer)).toBe(true);
});

describe.each(["owned", "shared"] as const)("%s managed uniforms", ownership => {
  test("an equal set keeps the capture; equality is against the latest bytes", async () => {
    const gpu = await init();
    try {
      const take = recordRanges(gpu);
      const { set, pass } = setup(gpu, ownership);
      const f = frame(gpu, f => {
        set({ value: 1 }); pass(f);
        set({ value: 1 }); pass(f);
        set({ value: 2 }); pass(f);
        set({ value: 2 }); pass(f);
        set({ value: 1 }); pass(f);
      });
      const ranges = take();
      expect(ranges.map(range => range.value)).toEqual([1, 1, 2, 2, 1]);
      expect(ranges[1]!.offset).toBe(ranges[0]!.offset);
      expect(ranges[3]!.offset).toBe(ranges[2]!.offset);
      expect(new Set(ranges.map(range => range.offset)).size).toBe(3);
      await f.done;
      const binds = vi.spyOn(gpu.gpu, "createBindGroup");
      for (let i = 0; i < 3; i++) await frame(gpu, f => { set({ value: 1 }); pass(f); }).done;
      expect(take().map(range => range.value)).toEqual([1, 1, 1]);
      expect(binds).not.toHaveBeenCalled();
    } finally { gpu.dispose(); }
  });

  test("the first upload is never compared with implicit zeros", async () => {
    const gpu = await init();
    try {
      const writes = stableWrites(gpu);
      const take = recordRanges(gpu);
      const { fx, color, set } = setup(gpu, ownership, { value: 0 });
      set({ value: 0 });
      fx.draw(color);
      expect(writes()).toBe(1);
      expect(take().map(range => range.value)).toEqual([0]);
    } finally { gpu.dispose(); }
  });

  test("a pending upload stays pending and a clean buffer stays clean", async () => {
    const gpu = await init();
    try {
      const take = recordRanges(gpu);
      const { fx, color, set } = setup(gpu, ownership);
      fx.draw(color);
      take();
      const writes = stableWrites(gpu);
      set({ value: 5 });
      set({ value: 5 });
      fx.draw(color);
      expect(writes()).toBe(1);
      expect(take().map(range => range.value)).toEqual([5]);
      set({ value: 5 });
      fx.draw(color);
      expect(writes()).toBe(1);
    } finally { gpu.dispose(); }
  });

  test("an equal set after a failed upload still retries it", async () => {
    const gpu = await init();
    try {
      const { fx, color, set } = setup(gpu, ownership);
      fx.draw(color);
      const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
      set({ value: 6 });
      writes.mockImplementationOnce(() => { throw new Error("upload failed"); });
      expect(() => fx.draw(color)).toThrow("upload failed");
      set({ value: 6 });
      fx.draw(color);
      expect(writes).toHaveBeenCalledTimes(2);
      const bytes = writes.mock.calls[1]![2] as ArrayBuffer | Uint8Array;
      const view = bytes instanceof ArrayBuffer ? new DataView(bytes) : new DataView(bytes.buffer, bytes.byteOffset);
      expect(view.getFloat32(0, true)).toBe(6);
    } finally { gpu.dispose(); }
  });

  test("live uniforms still write equal values and restore externally changed contents", async () => {
    const gpu = await init();
    try {
      const { fx, color, set, pass } = setup(gpu, ownership);
      bundle(gpu, { target: color }, p => p.draw(fx));
      const writes = stableWrites(gpu);
      set({ value: 1 });
      expect(writes()).toBe(1);
      const take = recordRanges(gpu);
      const binding = gpu.gpu.queue.writeBuffer as unknown as { mock: { calls: [GPUBuffer][] } };
      const stable = binding.mock.calls.at(-1)![0] as unknown as { __vgpuMockBytes: Uint8Array };
      stable.__vgpuMockBytes.fill(0xff);
      set({ value: 1 });
      expect(writes()).toBe(2);
      expect(new DataView(stable.__vgpuMockBytes.buffer).getFloat32(0, true)).toBe(1);
      const f = frame(gpu, f => { pass(f); set({ value: 1 }); pass(f); });
      const ranges = take();
      expect(ranges[0]!.offset).toBe(ranges[1]!.offset);
      await f.done;
    } finally { gpu.dispose(); }
  });

  test("an in-place typed array change is a new value", async () => {
    const gpu = await init();
    try {
      const take = recordRanges(gpu);
      const { set, pass } = setup(gpu, ownership);
      const tail = new Float32Array([1, 2, 3, 4]);
      const f = frame(gpu, f => {
        set({ tail }); pass(f);
        tail[0] = 9;
        set({ tail }); pass(f);
      });
      const ranges = take();
      expect(ranges[0]!.offset).not.toBe(ranges[1]!.offset);
      expect(new DataView(ranges[1]!.bytes.buffer).getFloat32(16, true)).toBe(9);
      await f.done;
    } finally { gpu.dispose(); }
  });

  test("equality is decided on packed bytes", async () => {
    const gpu = await init();
    try {
      const take = recordRanges(gpu);
      const { set, pass } = setup(gpu, ownership);
      const f = frame(gpu, f => {
        set({ value: 1 }); pass(f);
        set({ value: 1 + 1e-9 }); pass(f); // rounds to the same f32
        set({ value: -0 }); pass(f);
        set({ value: 0 }); pass(f); // +0 and -0 differ bitwise
        set({ value: Number.NaN }); pass(f);
        set({ value: Number.NaN }); pass(f);
      });
      const offsets = take().map(range => range.offset);
      expect(offsets[1]).toBe(offsets[0]);
      expect(offsets[3]).not.toBe(offsets[2]);
      expect(offsets[5]).toBe(offsets[4]);
      await f.done;
    } finally { gpu.dispose(); }
  });

  test("an invalid set changes nothing and keeps validation errors", async () => {
    const gpu = await init();
    try {
      const take = recordRanges(gpu);
      const { set, pass } = setup(gpu, ownership);
      const f = frame(gpu, f => {
        set({ value: 3 }); pass(f);
        expect(() => set({ value: "x" })).toThrow(expect.objectContaining({ code: "VGPU-SET-VALUE-INVALID" }));
        set({ value: 3 }); pass(f);
      });
      const ranges = take();
      expect(ranges.map(range => range.value)).toEqual([3, 3]);
      expect(ranges[1]!.offset).toBe(ranges[0]!.offset);
      await f.done;
    } finally { gpu.dispose(); }
  });

  test("an equal partial set still updates the merged CPU value", async () => {
    const gpu = await init();
    try {
      const take = recordRanges(gpu);
      const { set, pass } = setup(gpu, ownership);
      const f = frame(gpu, f => {
        set({ value: 1, tail: [1, 2, 3, 4] }); pass(f);
        set({ value: 1 }); pass(f);
        set({ tail: [5, 6, 7, 8] }); pass(f);
      });
      const ranges = take();
      expect(ranges[1]!.offset).toBe(ranges[0]!.offset);
      expect(ranges[2]!.value).toBe(1);
      expect(new DataView(ranges[2]!.bytes.buffer).getFloat32(16, true)).toBe(5);
      await f.done;
    } finally { gpu.dispose(); }
  });

  test("an unchanged revision reuses its uniform value object", async () => {
    const gpu = await init();
    try {
      const values: UniformValue[] = [];
      const capture = FrameUniforms.prototype.capture;
      vi.spyOn(FrameUniforms.prototype, "capture").mockImplementation(function (this: FrameUniforms, value, cache) { values.push(value); return capture.call(this, value, cache); });
      const { set, pass } = setup(gpu, ownership);
      await frame(gpu, f => { pass(f); set({ value: 1 }); pass(f); }).done;
      await frame(gpu, f => pass(f)).done;
      set({ value: 2 });
      await frame(gpu, f => pass(f)).done;
      expect(values[1]).toBe(values[0]);
      expect(values[2]).toBe(values[0]);
      expect(values[3]).not.toBe(values[0]);
      expect(values[3]!.revision).toBe(values[0]!.revision + 1);
    } finally { gpu.dispose(); }
  });
});

test("a member shorthand starts from zero and its first set uploads", async () => {
  const gpu = await init();
  try {
    const writes = stableWrites(gpu);
    const take = recordRanges(gpu);
    const fx = effect(gpu, FRAGMENT);
    const color = target(gpu, { size: [1, 1] });
    fx.set({ value: 0 });
    fx.set({ tail: [0, 0, 0, 0] });
    fx.draw(color);
    expect(writes()).toBe(1);
    expect(take().map(range => range.value)).toEqual([0]);
  } finally { gpu.dispose(); }
});

test.each(["owned", "shared"] as const)("%s storage bindings write every set, equal or not", async ownership => {
  const gpu = await init();
  try {
    const shared = ownership === "shared" ? uniforms(gpu, { value: 1 }) : undefined;
    const sim = compute(gpu, STORAGE, { set: { params: shared ?? { value: 1 } } });
    sim.dispatch(1);
    const writes = stableWrites(gpu);
    for (let i = 0; i < 3; i++) {
      if (shared) shared.set({ value: 1 });
      else sim.set({ params: { value: 1 } });
    }
    expect(writes()).toBe(3);
  } finally { gpu.dispose(); }
});
