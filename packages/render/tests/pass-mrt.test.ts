import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { material, Mesh } from "@vgpu/render";
import { pass, renderTarget, renderTargetMulti } from "@vgpu/render/passes";

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

test("pass with single-color RT and scalar clearColor is unchanged", async () => {
  const { device, scene, recorder } = await setup();
  const target = await renderTarget({ device, size: [8, 4] });
  pass({ ...scene, target, clearColor: [1, 0, 0, 1] });
  expect(recorder.descriptor().colorAttachments[0]?.clearValue).toEqual(RED);
  device.destroy();
});

test("pass broadcasts scalar clearColor to MRT attachments", async () => {
  const { device, scene, recorder } = await setup();
  const target = await mrt(device, 2);
  pass({ ...scene, target, clearColor: [1, 0, 0, 1] });
  expect(recorder.descriptor().colorAttachments.map((a) => a?.clearValue)).toEqual([RED, RED]);
  device.destroy();
});

test("pass applies per-attachment clearColor array", async () => {
  const { device, scene, recorder } = await setup();
  const target = await mrt(device, 2);
  pass({ ...scene, target, clearColor: [[1, 0, 0, 1], [0, 0, 0, 1]] });
  expect(recorder.descriptor().colorAttachments.map((a) => a?.clearValue)).toEqual([RED, BLACK]);
  device.destroy();
});

test("pass rejects clearColor arrays with wrong target shape or length", async () => {
  const { device, scene } = await setup();
  const target = await mrt(device, 3);
  expectInvalid(() => pass({ ...scene, target, clearColor: [[1, 0, 0, 1], [0, 0, 0, 1]] }));
  const texture = device.createTexture({ size: [8, 4], format: "rgba8unorm", usage: ["render_attachment"] });
  expectInvalid(() => pass({ ...scene, target: texture, clearColor: [[1, 0, 0, 1], [0, 0, 0, 1]] }));
  device.destroy();
});

test("pass broadcasts scalar colorLoadOp to MRT attachments", async () => {
  const { device, scene, recorder } = await setup();
  const target = await mrt(device, 2);
  pass({ ...scene, target, colorLoadOp: "load" });
  expect(recorder.descriptor().colorAttachments.map((a) => a?.loadOp)).toEqual(["load", "load"]);
  device.destroy();
});

test("pass clearColor disambiguates scalar tuple and object array", async () => {
  const { device, scene, recorder } = await setup();
  const target = await mrt(device, 2);
  pass({ ...scene, target, clearColor: [1, 0, 0, 1] });
  expect(recorder.descriptor().colorAttachments.map((a) => a?.clearValue)).toEqual([RED, RED]);
  pass({ ...scene, target, clearColor: [RED, BLACK] });
  expect(recorder.descriptor().colorAttachments.map((a) => a?.clearValue)).toEqual([RED, BLACK]);
  device.destroy();
});

function expectInvalid(fn: () => void) {
  try { fn(); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); return; }
  throw new Error("Expected VGPU-CORE-INVALID-USAGE");
}

async function setup() {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = { material: testMaterial(device), mesh: Mesh.box({ device }) };
  const recorder = installRecorder(device);
  return { device, scene, recorder };
}

function mrt(device: Device, count: 2 | 3) {
  const colors = Array.from({ length: count }, () => ({ format: "rgba8unorm" as GPUTextureFormat }));
  return renderTargetMulti({ device, size: [8, 4], colors });
}

function testMaterial(device: Device) {
  const fragment = `struct Out { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f }; @fragment fn fs_main() -> Out { return Out(vec4f(1), vec4f(1), vec4f(1)); }`;
  return material({ device, vertex: `struct V{ @location(0) position: vec3f, @location(1) normal: vec3f }; @vertex fn vs_main(v: V) -> @builtin(position) vec4f { return vec4f(v.position, 1); }`, fragment, uniforms: {}, vertexLayout: "position-normal", targetFormat: "rgba8unorm", depthFormat: null });
}

function installRecorder(device: Device) {
  let descriptor: GPURenderPassDescriptor | undefined;
  const passEncoder = { setViewport: vi.fn(), setScissorRect: vi.fn(), setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn() };
  const beginRenderPass = vi.fn((desc: GPURenderPassDescriptor) => { descriptor = desc; return passEncoder as unknown as GPURenderPassEncoder; });
  vi.spyOn(device.gpu, "createCommandEncoder").mockReturnValue({ beginRenderPass, finish: vi.fn(() => ({} as GPUCommandBuffer)) } as unknown as GPUCommandEncoder);
  vi.spyOn(device.queue.gpu, "submit");
  return { descriptor: () => descriptor as GPURenderPassDescriptor };
}
