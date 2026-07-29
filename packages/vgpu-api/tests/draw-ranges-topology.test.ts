import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation, init, draw, geometry, target } from "../src/mock.ts";
import { pipelineKeyOf } from "../src/pipeline-store.ts";

const WGSL = `
@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const MESHLESS_WGSL = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

test("topology and stripIndexFormat participate in pipeline descriptors and keys while ranges do not", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2] });
    const a = geometry(gpu, { topology: "triangle-strip", buffers: [{ data: new Float32Array([0, 0, 1, 0]), attributes: { position: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1]) });
    const b = geometry(gpu, { topology: "line-strip", buffers: [{ data: new Float32Array([0, 0, 1, 0]), attributes: { position: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1]) });

    draw(gpu, { shader: WGSL, label: "strip-a", geometry: a }).draw(colorTarget);
    draw(gpu, { shader: WGSL, label: "strip-b", geometry: b }).draw(colorTarget);

    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(mock.createRenderPipelineDescriptors.at(-2)?.primitive).toMatchObject({ topology: "triangle-strip", stripIndexFormat: "uint16" });
    expect(mock.createRenderPipelineDescriptors.at(-1)?.primitive).toMatchObject({ topology: "line-strip", stripIndexFormat: "uint16" });
    expect(mock.calls.createRenderPipeline).toBe(2);

    const parts = { module: {} as GPUShaderModule, pipelineLayout: {} as GPUPipelineLayout, signature: { colors: ["rgba8unorm"] as const }, vertexBufferLayouts: a.vertexBufferLayouts, topology: a.topology, stripIndexFormat: a.stripIndexFormat };
    expect(pipelineKeyOf(parts)).toBe(pipelineKeyOf({ ...parts }));
    expect(pipelineKeyOf({ ...parts, topology: "line-strip" })).not.toBe(pipelineKeyOf(parts));
    const meshless = { module: {} as GPUShaderModule, pipelineLayout: {} as GPUPipelineLayout, signature: { colors: ["rgba8unorm"] as const } };
    expect(pipelineKeyOf({ ...meshless, topology: undefined, stripIndexFormat: undefined })).toBe(pipelineKeyOf(meshless));
  } finally {
    gpu.dispose();
  }
});

test("cull and frontFace participate in pipeline descriptors and keys", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2] });
    draw(gpu, { shader: MESHLESS_WGSL, label: "cull-back", cull: "back", frontFace: "cw" }).draw(colorTarget);
    draw(gpu, { shader: MESHLESS_WGSL, label: "cull-front", cull: "front" }).draw(colorTarget);
    draw(gpu, { shader: MESHLESS_WGSL, label: "cull-default" }).draw(colorTarget);

    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(mock.createRenderPipelineDescriptors.at(-3)?.primitive).toEqual({ topology: "triangle-list", cullMode: "back", frontFace: "cw" });
    expect(mock.createRenderPipelineDescriptors.at(-2)?.primitive).toEqual({ topology: "triangle-list", cullMode: "front" });
    expect(mock.createRenderPipelineDescriptors.at(-1)?.primitive).toEqual({ topology: "triangle-list" });
    expect(mock.calls.createRenderPipeline).toBe(3);

    const parts = { module: {} as GPUShaderModule, pipelineLayout: {} as GPUPipelineLayout, signature: { colors: ["rgba8unorm"] as const } };
    expect(pipelineKeyOf({ ...parts, cullMode: "back" })).not.toBe(pipelineKeyOf(parts));
    expect(pipelineKeyOf({ ...parts, cullMode: "back", frontFace: "cw" })).not.toBe(pipelineKeyOf({ ...parts, cullMode: "back" }));
    expect(pipelineKeyOf({ ...parts, cullMode: undefined, frontFace: undefined })).toBe(pipelineKeyOf(parts));
  } finally {
    gpu.dispose();
  }
});

test("invalid cull and frontFace options fail at draw construction", async () => {
  const gpu = await init();
  try {
    expect(() => draw(gpu, { shader: MESHLESS_WGSL, label: "badCull", cull: "backwards" as never })).toThrowError(/VGPU-CULL-INVALID|Invalid cull/);
    expect(() => draw(gpu, { shader: MESHLESS_WGSL, label: "badFace", frontFace: "clockwise" as never })).toThrowError(/VGPU-FRONTFACE-INVALID|Invalid frontFace/);
  } finally {
    gpu.dispose();
  }
});

test("indexed draw ranges and instance counts use draw options over slice over geometry", async () => {
  const gpu = await init();
  const indexedCalls = spyIndexedDraws(gpu.device.gpu);
  try {
    const geo = geometry(gpu, {
      instanceCount: 5,
      buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }],
      indices: new Uint16Array([0, 1, 2, 0, 2, 1]),
    });
    const slice = geo.slice({ firstIndex: 2, indexCount: 3, baseVertex: 1, instanceCount: 4 });
    const drawable = draw(gpu, { shader: WGSL, label: "ranges", geometry: slice, instances: 6 });
    const colorTarget = target(gpu, { size: [2, 2] });

    drawable.draw(colorTarget);
    drawable.draw({ target: colorTarget, indices: 2, firstIndex: 1, baseVertex: 0, instances: 7 });
    drawable.draw({ target: colorTarget, indices: 6, firstIndex: 0 });

    expect(indexedCalls).toEqual([
      [3, 6, 2, 1, 0],
      [2, 7, 1, 0, 0],
      [6, 6, 0, 1, 0],
    ]);
    expect(() => drawable.draw({ target: colorTarget, indices: 5 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => drawable.draw({ target: colorTarget, indices: 6, firstIndex: 1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => drawable.draw({ target: colorTarget, indices: -1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("structural GeometryLike ranges remain a native-validation escape hatch", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [2, 2] });
    const vertexBuffer = gpu.device.gpu.createBuffer({ size: 64, usage: 32 });
    const layout = [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" as const }] }];
    expect(() => draw(gpu, { shader: WGSL, geometry: { vertexBuffers: [vertexBuffer], vertexBufferLayouts: layout, vertexCount: 3, firstVertex: 2 } }).draw(colorTarget)).not.toThrow();
    const indexBuffer = gpu.device.gpu.createBuffer({ size: 64, usage: 16 });
    expect(() => draw(gpu, { shader: WGSL, geometry: { vertexBuffers: [vertexBuffer], vertexBufferLayouts: layout, indexBuffer, indexFormat: "uint16", indexCount: 3, firstIndex: 2 } }).draw(colorTarget)).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("non-indexed draw overrides validate absolute intervals against the parent geometry", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, { buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1, 2, 1, 1, 2]), attributes: { position: { format: "float32x2", location: 0 } } }] });
    const slice = geo.slice({ firstVertex: 2, vertexCount: 2 });
    const drawable = draw(gpu, { shader: WGSL, label: "vertex-ranges", geometry: slice });
    const colorTarget = target(gpu, { size: [2, 2] });
    expect(() => drawable.draw({ target: colorTarget, firstVertex: 1, vertices: 5 })).not.toThrow();
    expect(() => drawable.draw({ target: colorTarget, firstVertex: 2, vertices: 5 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => drawable.draw({ target: colorTarget, firstVertex: Number.NaN })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
  } finally {
    gpu.dispose();
  }
});

function spyIndexedDraws(device: GPUDevice): unknown[][] {
  const drawCalls: unknown[][] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        const pass = originalBeginRenderPass(renderPassDescriptor);
        const originalDrawIndexed = pass.drawIndexed.bind(pass);
        return {
          ...pass,
          drawIndexed(...args: Parameters<GPURenderPassEncoder["drawIndexed"]>): void {
            drawCalls.push([...args]);
            originalDrawIndexed(...args);
          },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return drawCalls;
}
