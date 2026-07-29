import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation, init, VGPUError, geometry, draw, target } from "../src/mock.ts";

const FS = `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`;

function errorOf(fn: () => unknown): VGPUError {
  try { fn(); } catch (error) { if (error instanceof VGPUError) return error; throw error; }
  throw new Error("Expected a VGPUError");
}

test("named geometry attributes resolve to reflected vertex locations at draw(gpu, opts) construction", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, { buffers: [{ data: new Float32Array(15), attributes: {
      uv: "float32x2",
      position: "float32x3",
    } }] });
    const shader = `
      @vertex fn vs_main(@location(4) position: vec3f, @location(1) uv: vec2f) -> @builtin(position) vec4f { return vec4f(position, 1.0); }
      ${FS}
    `;
    const colorTarget = target(gpu, { size: [1, 1] });
    draw(gpu, { shader, geometry: geo }).draw(colorTarget);
    const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1)!;
    expect(desc.vertex.buffers).toEqual([{ arrayStride: 20, attributes: [
      { shaderLocation: 1, offset: 0, format: "float32x2" },
      { shaderLocation: 4, offset: 8, format: "float32x3" },
    ] }]);
  } finally { gpu.dispose(); }
});

test("explicit locations win over attribute names", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, { buffers: [{ data: new Float32Array(2), attributes: { label_only: { format: "float32x2", location: 3 } } }] });
    const shader = `@vertex fn vs_main(@location(3) actual_name: vec2f) -> @builtin(position) vec4f { return vec4f(actual_name, 0.0, 1.0); } ${FS}`;
    const colorTarget = target(gpu, { size: [1, 1] });
    draw(gpu, { shader, geometry: geo }).draw(colorTarget);
    const buffers = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1)!.vertex.buffers;
    expect(buffers).toEqual([{ arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: "float32x2" }] }]);
  } finally { gpu.dispose(); }
});

test("draw construction reports unmatched, ambiguous, missing, and format mismatch geometry inputs", async () => {
  const gpu = await init();
  try {
    const named = (attributes: Record<string, GPUVertexFormat | { format: GPUVertexFormat; location?: number }>) => geometry(gpu, { buffers: [{ data: new Float32Array(4), stride: 16, attributes }] });
    const unmatched = errorOf(() => draw(gpu, { shader: `@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); } ${FS}`, geometry: named({ color: "float32x4" }) }));
    const ambiguous = errorOf(() => draw(gpu, { shader: `struct In { @location(0) value: vec2f } @vertex fn vs_main(input: In, @location(1) value: vec2f) -> @builtin(position) vec4f { return vec4f(input.value + value, 0.0, 1.0); } ${FS}`, geometry: named({ value: "float32x2" }) }));
    const missing = errorOf(() => draw(gpu, { shader: `@vertex fn vs_main(@location(0) position: vec2f, @location(1) uv: vec2f) -> @builtin(position) vec4f { return vec4f(position + uv, 0.0, 1.0); } ${FS}`, geometry: named({ position: "float32x2" }) }));
    const mismatch = errorOf(() => draw(gpu, { shader: `@vertex fn vs_main(@location(0) position: vec2u) -> @builtin(position) vec4f { return vec4f(position); } ${FS}`, geometry: named({ position: "float32x2" }) }));
    expect([unmatched.code, ambiguous.code, missing.code, mismatch.code]).toEqual(["VGPU-MESH-ATTRIBUTE-UNMATCHED", "VGPU-MESH-ATTRIBUTE-UNMATCHED", "VGPU-MESH-INPUT-MISSING", "VGPU-MESH-FORMAT-MISMATCH"]);
    for (const error of [unmatched, ambiguous, missing, mismatch]) expect(error.fix).toBeTruthy();
  } finally { gpu.dispose(); }
});

test("structural GeometryLike escape hatches skip name and format checks", async () => {
  const gpu = await init();
  try {
    expect(() => draw(gpu, { shader: `@vertex fn vs_main(@location(7) anything: vec4u) -> @builtin(position) vec4f { return vec4f(anything); } ${FS}`, geometry: {
      vertexCount: 1,
      vertexBuffers: [gpu.device.gpu.createBuffer({ size: 16, usage: 32 })],
      vertexBufferLayouts: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
    } })).not.toThrow();
  } finally { gpu.dispose(); }
});
