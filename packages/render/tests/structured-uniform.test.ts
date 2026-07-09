import { expect, test, vi } from "vitest";
import { bind, createMockGPUDevice, Device, getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { material, StructuredUniform, type WgslUniformType } from "@vgpu/render";

const uniformUsage = 64;
const copyDstUsage = 8;

const vertex = `
struct VertexIn { @location(0) position: vec3<f32> };
@vertex fn vs_main(in: VertexIn) -> @builtin(position) vec4<f32> { return vec4<f32>(in.position, 1.0); }
`;
const fragment = `@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;

function makeDevice(): Device {
  return new Device(createMockGPUDevice(), null);
}

test("derives the same layout as material() for the same schema", () => {
  const device = makeDevice();
  const schema = { a: "f32", b: "vec2f", c: "vec3f", d: "mat3x3f", e: "mat4x4f" } as const;

  const uniform = new StructuredUniform(device, { schema });
  const mat = material({ device, vertex, fragment, uniforms: schema, vertexLayout: "position-only", targetFormat: "rgba8unorm" });

  expect(uniform.byteSize).toBe(mat.uniformByteSize);
  expect(uniform.offsets).toEqual(mat.uniformOffsets);
  expect(uniform.layout.byteSize).toBe(mat.uniformByteSize);
  expect(uniform.layout.offsets).toEqual(mat.uniformOffsets);
  device.destroy();
});

test("creates only the buffer at construction and lazily creates bind group objects", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");
  const uniform = new StructuredUniform(device, { schema: { time: "f32" }, label: "globals" });
  const mock = getMockGPUDeviceInstrumentation(device.gpu);

  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.createBufferDescriptors[0]).toMatchObject({ label: "globals", size: 16, usage: uniformUsage | copyDstUsage });
  expect(createBindGroupLayout).not.toHaveBeenCalled();
  expect(mock.calls.createBindGroup).toBe(0);

  const layout = uniform.bindGroupLayout;
  expect(uniform.bindGroupLayout).toBe(layout);
  expect(createBindGroupLayout).toHaveBeenCalledTimes(1);
  expect(createBindGroupLayout.mock.calls[0]?.[0]).toMatchObject({
    label: "globals.bgl",
    entries: [{ binding: 0, visibility: 3, buffer: { type: "uniform", minBindingSize: 16 } }],
  });

  const group = uniform.bindGroup;
  expect(uniform.bindGroup).toBe(group);
  expect(mock.calls.createBindGroup).toBe(1);
  expect(mock.createBindGroupDescriptors[0]).toMatchObject({ label: "globals.bg", layout });
  expect([...mock.createBindGroupDescriptors[0]!.entries]).toEqual([{ binding: 0, resource: { buffer: uniform.gpu } }]);
  device.destroy();
});

test("writes partial values into a persistent zero-initialized scratch buffer", async () => {
  const device = makeDevice();
  const uniform = new StructuredUniform(device, { schema: { a: "f32", b: "vec3f", c: "f32" } });

  uniform.write({ b: new Float32Array([2, 3, 4]) });
  let floats = new Float32Array(await uniform.buffer.read(uniform.byteSize));
  expect(Array.from(floats)).toEqual([0, 0, 0, 0, 2, 3, 4, 0]);

  uniform.write({ a: 1, c: 5 });
  floats = new Float32Array(await uniform.buffer.read(uniform.byteSize));
  expect(Array.from(floats)).toEqual([1, 0, 0, 0, 2, 3, 4, 5]);
  device.destroy();
});

test("writes integer vectors, mat3x3f column padding, and mat4x4f contiguously", async () => {
  const device = makeDevice();
  const uniform = new StructuredUniform(device, { schema: { flag: "u32", normal: "vec3i", basis: "mat3x3f", transform: "mat4x4f" } });

  uniform.write({
    flag: 7,
    normal: new Int32Array([-1, -2, -3]),
    basis: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    transform: Array.from({ length: 16 }, (_, i) => i + 10),
  });

  const view = new DataView(await uniform.buffer.read(uniform.byteSize));
  expect(view.getUint32(0, true)).toBe(7);
  expect([view.getInt32(16, true), view.getInt32(20, true), view.getInt32(24, true)]).toEqual([-1, -2, -3]);
  expect(Array.from(new Float32Array(view.buffer.slice(32, 80)))).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
  expect(Array.from(new Float32Array(view.buffer.slice(80, 144)))).toEqual(Array.from({ length: 16 }, (_, i) => i + 10));
  device.destroy();
});

test("writes Uint32Array vector inputs", async () => {
  const device = makeDevice();
  const uniform = new StructuredUniform(device, { schema: { flags: "vec4u" } });

  uniform.write({ flags: new Uint32Array([1, 2, 3, 4]) });

  const view = new DataView(await uniform.buffer.read(uniform.byteSize));
  expect([0, 4, 8, 12].map((offset) => view.getUint32(offset, true))).toEqual([1, 2, 3, 4]);
  device.destroy();
});

test("uploads the whole buffer on every write", () => {
  const device = makeDevice();
  const uniform = new StructuredUniform(device, { schema: { a: "f32", b: "vec3f" } });
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");

  uniform.write({ a: 1 });

  expect(writeBuffer).toHaveBeenCalledTimes(1);
  expect(writeBuffer.mock.calls[0]?.[0]).toBe(uniform.gpu);
  expect(writeBuffer.mock.calls[0]?.[1]).toBe(0);
  expect(writeBuffer.mock.calls[0]?.[2]).toBeInstanceOf(ArrayBuffer);
  expect((writeBuffer.mock.calls[0]?.[2] as ArrayBuffer).byteLength).toBe(uniform.byteSize);
  device.destroy();
});

test("rejects empty schemas, unsupported schema types, unknown write keys, scalar objects, and wrong vector lengths", () => {
  const device = makeDevice();
  expectInvalid(() => new StructuredUniform(device, { schema: {} }));
  expectInvalid(() => new StructuredUniform(device, { schema: { nested: "struct Foo" as WgslUniformType } }));

  const uniform = new StructuredUniform(device, { schema: { time: "f32", dir: "vec3f", m: "mat3x3f" } });
  expectInvalid(() => uniform.write({ typo: 1 } as never));
  expectInvalid(() => uniform.write({ time: [1] } as never));
  expectInvalid(() => uniform.write({ dir: [1, 2] }));
  expectInvalid(() => uniform.write({ dir: [1, 2, 3, 4] }));
  expectInvalid(() => uniform.write({ m: Array.from({ length: 8 }, (_, i) => i) }));
  device.destroy();
});

test("emits a WGSL struct declaration and is bind.resource-compatible", () => {
  const device = makeDevice();
  const uniform = new StructuredUniform(device, { schema: { viewProj: "mat4x4f", cameraPos: "vec3f", passKind: "f32" } });

  expect(uniform.wgsl("Params")).toBe([
    "struct Params {",
    "  viewProj: mat4x4<f32>,",
    "  cameraPos: vec3<f32>,",
    "  passKind: f32,",
    "};",
  ].join("\n"));
  expect(uniform.wgsl()).toContain("struct Uniforms");
  expect(bind.resource(0, uniform)).toEqual({ binding: 0, resource: { buffer: uniform.gpu } });
  device.destroy();
});

test("supports string-array visibility values", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");
  const uniform = new StructuredUniform(device, { schema: { time: "f32" }, visibility: ["compute"] });

  void uniform.bindGroupLayout;

  expect(createBindGroupLayout.mock.calls[0]?.[0].entries[0]?.visibility).toBe(4);
  device.destroy();
});

test("bind group getters reject access after destroy", () => {
  const device = makeDevice();
  const uniform = new StructuredUniform(device, { schema: { time: "f32" } });

  void uniform.bindGroup;
  uniform.destroy();

  expectInvalid(() => uniform.bindGroupLayout);
  expectInvalid(() => uniform.bindGroup);
  device.destroy();
});

test("destroy and dispose are idempotent and Symbol.dispose delegates to destroy", () => {
  const device = makeDevice();
  const uniform = new StructuredUniform(device, { schema: { time: "f32" } });
  const destroy = vi.spyOn(uniform.buffer, "destroy");

  uniform.dispose();
  uniform.destroy();
  uniform[Symbol.dispose]();

  expect(destroy).toHaveBeenCalledTimes(1);
  device.destroy();
});

function expectInvalid(fn: () => unknown): void {
  try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); }
  catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); }
}
