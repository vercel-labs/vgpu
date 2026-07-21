import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation, init } from "../src/mock.ts";
import { pipelineKeyOf } from "../src/pipeline-store.ts";

const WGSL = `
@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

test("topology and stripIndexFormat participate in pipeline descriptors and keys while ranges do not", async () => {
  const gpu = await init();
  try {
    const target = gpu.target({ size: [2, 2] });
    const a = gpu.mesh({ topology: "triangle-strip", buffers: [{ data: new Float32Array([0, 0, 1, 0]), attributes: { position: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1]) });
    const b = gpu.mesh({ topology: "line-strip", buffers: [{ data: new Float32Array([0, 0, 1, 0]), attributes: { position: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1]) });

    gpu.draw({ shader: WGSL, label: "strip-a", mesh: a }).draw(target);
    gpu.draw({ shader: WGSL, label: "strip-b", mesh: b }).draw(target);

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

test("indexed draw ranges and instance counts use draw options over slice over mesh", async () => {
  const gpu = await init();
  const indexedCalls = spyIndexedDraws(gpu.device.gpu);
  try {
    const mesh = gpu.mesh({
      instanceCount: 5,
      buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }],
      indices: new Uint16Array([0, 1, 2, 0, 2, 1]),
    });
    const slice = mesh.slice({ firstIndex: 2, indexCount: 3, baseVertex: 1, instanceCount: 4 });
    const draw = gpu.draw({ shader: WGSL, label: "ranges", mesh: slice, instances: 6 });
    const target = gpu.target({ size: [2, 2] });

    draw.draw(target);
    draw.draw({ target, indices: 2, firstIndex: 1, baseVertex: 0, instances: 7 });
    draw.draw({ target, indices: 6, firstIndex: 0 });

    expect(indexedCalls).toEqual([
      [3, 6, 2, 1, 0],
      [2, 7, 1, 0, 0],
      [6, 6, 0, 1, 0],
    ]);
    expect(() => draw.draw({ target, indices: 5 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => draw.draw({ target, indices: 6, firstIndex: 1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => draw.draw({ target, indices: -1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("structural MeshLike ranges remain a native-validation escape hatch", async () => {
  const gpu = await init();
  try {
    const target = gpu.target({ size: [2, 2] });
    const vertexBuffer = gpu.device.gpu.createBuffer({ size: 64, usage: 32 });
    const layout = [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" as const }] }];
    expect(() => gpu.draw({ shader: WGSL, mesh: { vertexBuffers: [vertexBuffer], vertexBufferLayouts: layout, vertexCount: 3, firstVertex: 2 } }).draw(target)).not.toThrow();
    const indexBuffer = gpu.device.gpu.createBuffer({ size: 64, usage: 16 });
    expect(() => gpu.draw({ shader: WGSL, mesh: { vertexBuffers: [vertexBuffer], vertexBufferLayouts: layout, indexBuffer, indexFormat: "uint16", indexCount: 3, firstIndex: 2 } }).draw(target)).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("non-indexed draw overrides validate absolute intervals against the parent mesh", async () => {
  const gpu = await init();
  try {
    const mesh = gpu.mesh({ buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1, 2, 1, 1, 2]), attributes: { position: { format: "float32x2", location: 0 } } }] });
    const slice = mesh.slice({ firstVertex: 2, vertexCount: 2 });
    const draw = gpu.draw({ shader: WGSL, label: "vertex-ranges", mesh: slice });
    const target = gpu.target({ size: [2, 2] });
    expect(() => draw.draw({ target, firstVertex: 1, vertices: 5 })).not.toThrow();
    expect(() => draw.draw({ target, firstVertex: 2, vertices: 5 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => draw.draw({ target, firstVertex: Number.NaN })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
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
