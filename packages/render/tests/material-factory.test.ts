import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device, type VGPUAdapter } from "@vgpu/core";
import { material, type Material, type WgslUniformType } from "@vgpu/render";

const vertex = `
struct VertexIn { @location(0) position: vec3<f32> };
@vertex fn vs_main(in: VertexIn) -> @builtin(position) vec4<f32> { return vec4<f32>(in.position, 1.0); }
`;
const fragment = `@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;

test("material returns a valid Material with correct uniformByteSize", async () => {
  const { device } = await testDevice();
  expect(make(device, { time: "f32" }).uniformByteSize).toBe(16);
  expect(make(device, { a: "f32", b: "vec3f" }).uniformByteSize).toBe(32);
  device.destroy();
});

test("material correctly aligns vec3 to 16-byte boundary", async () => {
  const { device } = await testDevice();
  expect(make(device, { x: "f32", v: "vec3f" }).uniformOffsets?.v).toBe(16);
  device.destroy();
});

test("material correctly aligns mat4x4 to 64 bytes", async () => {
  const { device } = await testDevice();
  expect(make(device, { m: "mat4x4f" }).uniformByteSize).toBe(64);
  expect(make(device, { m: "mat3x3f" }).uniformByteSize).toBe(48);
  device.destroy();
});

test("material throws VGPU-CORE-INVALID-USAGE if uniform name shadows 'uniforms'", async () => {
  const { device } = await testDevice();
  expectInvalid(() => make(device, { uniforms: "f32" }));
  device.destroy();
});

test("material throws VGPU-CORE-INVALID-USAGE if vertex shader fails to parse", async () => {
  const { device } = await testDevice();
  expect(() => material({ device, vertex: "@vertex fn vs_main( {", fragment, uniforms: {}, vertexLayout: "position-only" })).toThrow(/VGPU-CORE-INVALID-USAGE|WGSL error/);
  device.destroy();
});

test("writeUniforms throws if a uniform is missing", async () => {
  const { device } = await testDevice();
  const mat = make(device, { time: "f32", mouse: "vec2f" });
  expectInvalid(() => mat.writeUniforms?.({ time: 1 }));
  device.destroy();
});

test("writeUniforms throws if an extra key is passed", async () => {
  const { device } = await testDevice();
  const mat = make(device, { time: "f32" });
  expectInvalid(() => mat.writeUniforms?.({ time: 1, foo: 2 }));
  device.destroy();
});

test("writeUniforms correctly serializes f32/vec2f/vec3f/mat4x4f to bytes", async () => {
  const { device } = await testDevice();
  const mat = make(device, { a: "f32", b: "vec2f", c: "vec3f", d: "mat4x4f" });
  mat.writeUniforms?.({ a: 1.5, b: [2, 3], c: new Float32Array([4, 5, 6]), d: Array.from({ length: 16 }, (_, i) => i + 10) });
  const floats = new Float32Array(await device.readback.read(mat.gpu!.uniformBuffer!, mat.uniformByteSize, 0));
  expect(floats[0]).toBe(1.5);
  expect(Array.from(floats.slice(2, 4))).toEqual([2, 3]);
  expect(Array.from(floats.slice(4, 7))).toEqual([4, 5, 6]);
  expect(Array.from(floats.slice(8, 24))).toEqual(Array.from({ length: 16 }, (_, i) => i + 10));
  device.destroy();
});

function make(device: Device, uniforms: Record<string, WgslUniformType>): Material {
  return material({ device, vertex, fragment, uniforms, vertexLayout: "position-only", targetFormat: "rgba8unorm" });
}

function testDevice(): Promise<{ readonly device: Device }> {
  return App.create({ adapter: adapter() });
}

function adapter(): VGPUAdapter {
  return process.env.VGPU_DOCKER_TEST === "1" ? createNodeAdapter() : createMockAdapter();
}

function expectInvalid(fn: () => unknown): void {
  try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); }
  catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); }
}
