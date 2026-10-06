import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { expect, test, vi } from "vitest";
import { compute, frame, init, uniforms } from "../src/mock.ts";

test("raw GPUBuffer and GPUBufferBinding values bind as caller-owned resources", async () => {
  const gpu = await init();
  try {
    const alignment = gpu.gpu.limits.minUniformBufferOffsetAlignment;
    const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 64 });
    const kernel = compute(gpu, `
      @group(0) @binding(0) var<uniform> first: vec4f;
      @group(0) @binding(1) var<uniform> second: vec4f;
      @compute @workgroup_size(1) fn main() { let value = first + second; }
    `, { set: { first: raw, second: { buffer: raw, offset: alignment, size: 16 } } });

    kernel.dispatch(1);

    const descriptor = getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors.at(-1)!;
    expect(descriptor.entries.map(entry => entry.resource)).toEqual([
      { buffer: raw, offset: 0, size: alignment * 2 },
      { buffer: raw, offset: alignment, size: 16 },
    ]);
  } finally {
    gpu.dispose();
  }
});

test("canonical ranges reuse equivalent defaults and snapshot mutable descriptors", async () => {
  const gpu = await init();
  try {
    const alignment = gpu.gpu.limits.minUniformBufferOffsetAlignment;
    const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 64 });
    const kernel = compute(gpu, `
      @group(0) @binding(0) var<uniform> params: vec4f;
      @compute @workgroup_size(1) fn main() { let value = params; }
    `);
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    const dispatch = () => kernel.dispatch(1);

    kernel.set({ params: raw });
    dispatch();
    const initial = mock.calls.createBindGroup;
    kernel.set({ params: { buffer: raw, offset: 0, size: raw.size } });
    dispatch();
    expect(mock.calls.createBindGroup).toBe(initial);

    const range = { buffer: raw, offset: alignment, size: 16 };
    kernel.set({ params: range });
    dispatch();
    expect(mock.calls.createBindGroup).toBe(initial + 1);
    range.size = 32;
    dispatch();
    expect(mock.calls.createBindGroup).toBe(initial + 1);
    kernel.set({ params: range });
    dispatch();
    expect(mock.calls.createBindGroup).toBe(initial + 2);
    kernel.set({ params: { buffer: raw, offset: alignment, size: 16 } });
    dispatch();
    expect(mock.calls.createBindGroup).toBe(initial + 2);
  } finally {
    gpu.dispose();
  }
});

test("GPUBufferBinding dictionaries may expose inherited accessors", async () => {
  const gpu = await init();
  try {
    const raw = gpu.gpu.createBuffer({ size: 16, usage: 64 });
    const descriptor = Object.create({
      get buffer() { return raw; },
      offset: 0,
      size: 16,
    }) as GPUBufferBinding;
    const kernel = compute(gpu, `
      @group(0) @binding(0) var<uniform> params: vec4f;
      @compute @workgroup_size(1) fn main() { let value = params; }
    `);
    expect(() => kernel.set({ params: descriptor }).dispatch(1)).not.toThrow();
    expect(getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors.at(-1)!.entries[0]!.resource).toEqual({
      buffer: raw,
      offset: 0,
      size: 16,
    });
  } finally {
    gpu.dispose();
  }
});

test("plain structs with buffer-like member names still pack and SharedUniforms remain nominal", async () => {
  const gpu = await init();
  try {
    const packed = compute(gpu, `
      struct Range { buffer: u32, offset: u32, size: u32 }
      @group(0) @binding(0) var<uniform> range: Range;
      @compute @workgroup_size(1) fn main() { let value = range.buffer + range.offset + range.size; }
    `);
    packed.set({ range: { buffer: 3, offset: 4, size: 8 } }).set({ offset: 12 }).dispatch(1);
    const packedResource = getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors.at(-1)!.entries[0]!.resource as GPUBufferBinding;
    const bytes = (packedResource.buffer as GPUBuffer & { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)]).toEqual([3, 12, 8]);

    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const shared = uniforms(gpu, { value: 7 });
    const sharedKernel = compute(gpu, `
      struct Params { value: u32 }
      @group(0) @binding(0) var<uniform> params: Params;
      @compute @workgroup_size(1) fn main() { let value = params.value; }
    `, { set: { params: shared } });
    compute(gpu, `
      struct OtherParams { value: u32 }
      @group(0) @binding(0) var<uniform> params: OtherParams;
      @compute @workgroup_size(1) fn main() { let value = params.value; }
    `, { set: { params: shared } });
    expect(writes).not.toHaveBeenCalled();
    expect(() => sharedKernel.dispatch(1)).not.toThrow();
    expect(writes).toHaveBeenCalledTimes(1);
  } finally {
    gpu.dispose();
  }
});

test("invalid raw ranges fail transactionally with binding-specific fixes", async () => {
  const gpu = await init();
  try {
    const alignment = gpu.gpu.limits.minUniformBufferOffsetAlignment;
    const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 64 });
    const kernel = compute(gpu, `
      @group(0) @binding(0) var<uniform> params: vec4f;
      @compute @workgroup_size(1) fn main() { let value = params; }
    `, { label: "ranges", set: { params: { buffer: raw, offset: 0, size: 16 } } });
    kernel.dispatch(1);
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    const groups = mock.calls.createBindGroup;
    const invalid = [
      { offset: null, size: 16 }, { offset: "0", size: 16 }, { offset: Number.NaN, size: 16 },
      { offset: Number.POSITIVE_INFINITY, size: 16 }, { offset: 1.5, size: 16 },
      { offset: Number.MAX_SAFE_INTEGER + 1, size: 16 }, { offset: -1, size: 16 },
      { offset: 0, size: null }, { offset: 0, size: "16" }, { offset: 0, size: Number.NaN },
      { offset: 0, size: Number.POSITIVE_INFINITY }, { offset: 0, size: 1.5 },
      { offset: 0, size: Number.MAX_SAFE_INTEGER + 1 }, { offset: 0, size: -1 }, { offset: 0, size: 0 },
      { offset: raw.size + alignment, size: 16 }, { offset: raw.size, size: undefined },
      { offset: alignment, size: alignment + 1 }, { offset: 1, size: 16 }, { offset: 0, size: 8 },
    ] as const;
    for (const range of invalid) {
      expect(() => kernel.set({ params: { buffer: raw, ...range } as never })).toThrowError(expect.objectContaining({
        code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE",
        where: "set",
        message: expect.stringMatching(/params.*@group\(0\).*@binding\(0\).*range/),
        fix: expect.stringMatching(/uniform usage.*aligned.*size.*buffer\.size/i),
      }));
      expect(() => kernel.dispatch(1)).not.toThrow();
      expect(mock.calls.createBindGroup).toBe(groups);
    }

    const wrongUsage = gpu.gpu.createBuffer({ size: alignment, usage: 8 });
    expect(() => kernel.set({ params: wrongUsage })).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE" }));
    expect(() => kernel.set({ params: { buffer: raw, offset: 0, size: 17 } })).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("storage ranges require four-byte sizes and enforce granted maximums", async () => {
  const gpu = await init();
  try {
    const alignment = gpu.gpu.limits.minStorageBufferOffsetAlignment;
    const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 128 });
    const kernel = compute(gpu, `
      @group(0) @binding(0) var<storage, read> values: array<u32>;
      @compute @workgroup_size(1) fn main() { let value = values[0]; }
    `);
    expect(() => kernel.set({ values: { buffer: raw, offset: 0, size: 6 } })).toThrowError(expect.objectContaining({
      code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE",
      message: expect.stringContaining("multiple of 4"),
    }));
    Object.defineProperty(gpu.gpu.limits, "maxStorageBufferBindingSize", { value: 32, configurable: true });
    expect(() => kernel.set({ values: { buffer: raw, offset: 0, size: 36 } })).toThrowError(expect.objectContaining({
      code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE",
      message: expect.stringContaining("granted maximum"),
    }));
    expect(() => kernel.set({ values: { buffer: raw, offset: 0, size: 32 } }).dispatch(1)).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("writable storage aliasing compares native allocation across ranges and spellings", async () => {
  const gpu = await init();
  try {
    const alignment = gpu.gpu.limits.minStorageBufferOffsetAlignment;
    const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 128 });
    const other = gpu.gpu.createBuffer({ size: alignment, usage: 128 });
    const shader = `
      @group(0) @binding(0) var<storage, read> source: array<u32>;
      @group(0) @binding(1) var<storage, read_write> destination: array<u32>;
      @compute @workgroup_size(1) fn main() { destination[0] = source[0]; }
    `;
    const aliased = compute(gpu, shader, { set: {
      source: { buffer: raw, offset: 0, size: 4 },
      destination: { buffer: raw, offset: alignment, size: 4 },
    } });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    const encoders = mock.calls.createCommandEncoder;
    expect(() => aliased.dispatch(1)).toThrowError(expect.objectContaining({ code: "VGPU-R1-STORAGE-ALIASING" }));
    expect(mock.calls.createCommandEncoder).toBe(encoders);
    const pending = frame(gpu);
    expect(() => pending.computePass(pass => pass.dispatch(aliased, 1))).toThrowError(expect.objectContaining({ code: "VGPU-R1-STORAGE-ALIASING" }));
    pending.cancel();

    const tracked = gpu.device.wrapBuffer(raw);
    const mixed = compute(gpu, shader, { set: { source: tracked, destination: { buffer: raw, offset: alignment, size: 4 } } });
    expect(() => mixed.dispatch(1)).toThrowError(expect.objectContaining({ code: "VGPU-R1-STORAGE-ALIASING" }));

    const distinct = compute(gpu, shader, { set: { source: raw, destination: other } });
    expect(() => distinct.dispatch(1)).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("multiple read-only bindings may share one allocation while retaining range-distinct groups", async () => {
  const gpu = await init();
  try {
    const alignment = gpu.gpu.limits.minStorageBufferOffsetAlignment;
    const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 128 });
    const kernel = compute(gpu, `
      @group(0) @binding(0) var<storage, read> first: array<u32>;
      @group(0) @binding(1) var<storage, read> second: array<u32>;
      @compute @workgroup_size(1) fn main() { let value = first[0] + second[0]; }
    `, { set: {
      first: { buffer: raw, offset: 0, size: 4 },
      second: { buffer: raw, offset: alignment, size: 4 },
    } });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    kernel.dispatch(1);
    const groups = mock.calls.createBindGroup;
    kernel.set({ second: { buffer: raw, offset: alignment, size: 8 } }).dispatch(1);
    expect(mock.calls.createBindGroup).toBe(groups + 1);
    kernel.set({ second: { buffer: raw, offset: alignment, size: 4 } }).dispatch(1);
    expect(mock.calls.createBindGroup).toBe(groups + 1);
  } finally {
    gpu.dispose();
  }
});
