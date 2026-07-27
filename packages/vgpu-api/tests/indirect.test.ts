import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init } from "../src/mock.ts";
import type { StorageBuffer } from "../src/mock.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const MESH_SHADER = `
@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const COMPUTE_SHADER = `
@compute @workgroup_size(1) fn cs_main() {}
`;

const GPU_BUFFER_USAGE_INDIRECT = 256;

function gpuBufferOf(buffer: StorageBuffer): GPUBuffer {
  return (buffer as StorageBuffer & { readonly gpu: GPUBuffer }).gpu;
}

test("gpu.storage({ indirect: true }) appends the indirect usage and keeps access defaults", async () => {
  const gpu = await init();
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  const plain = gpu.storage(16);
  const plainUsage = mock.createBufferDescriptors.at(-1)!.usage;
  const args = gpu.storage(16, { indirect: true });
  const argsUsage = mock.createBufferDescriptors.at(-1)!.usage;
  const readArgs = gpu.storage(16, { access: "read", indirect: true });

  expect(plainUsage & GPU_BUFFER_USAGE_INDIRECT).toBe(0);
  expect(argsUsage & GPU_BUFFER_USAGE_INDIRECT).toBe(GPU_BUFFER_USAGE_INDIRECT);
  // The indirect flag only appends a usage; storage/copy bits and access semantics are unchanged.
  expect(argsUsage & plainUsage).toBe(plainUsage);
  expect(plain.access).toBe("read-write");
  expect(args.access).toBe("read-write");
  expect(readArgs.access).toBe("read");
  expect(gpu.storage(16, "read").access).toBe("read");
  gpu.dispose();
});

test("non-indexed indirect draws emit drawIndirect with the buffer and a default offset of 0", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const target = gpu.target({ size: [2, 2] });
  const args = gpu.storage(16, { indirect: true });

  gpu.draw({ shader: DRAW_SHADER, label: "gpu-driven" }).draw({ target, indirect: args });

  expect(ops).toEqual([["setPipeline"], ["drawIndirect", gpuBufferOf(args), 0]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("indirect accepts { buffer, offset } and forwards the custom offset", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const target = gpu.target({ size: [2, 2] });
  const args = gpu.storage(48, { indirect: true });
  const draw = gpu.draw({ shader: DRAW_SHADER, label: "offset-draw" });

  draw.draw({ target, indirect: { buffer: args } });
  draw.draw({ target, indirect: { buffer: args, offset: 32 } });

  expect(ops).toEqual([["setPipeline"], ["drawIndirect", gpuBufferOf(args), 0], ["setPipeline"], ["drawIndirect", gpuBufferOf(args), 32]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("indexed geometries emit drawIndexedIndirect with the index buffer still set", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const target = gpu.target({ size: [2, 2] });
  const geometry = gpu.geometry({ buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1, 2]) });
  const args = gpu.storage(20, { indirect: true });

  gpu.draw({ shader: MESH_SHADER, label: "indexed-gpu-driven", geometry }).draw({ target, indirect: args });

  expect(ops).toEqual([["setPipeline"], ["setVertexBuffer", 0], ["setIndexBuffer", geometry.indexBuffer, "uint16"], ["drawIndexedIndirect", gpuBufferOf(args), 0]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("indirect draws work in frame passes", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const target = gpu.target({ size: [2, 2] });
  const args = gpu.storage(16, { indirect: true });
  const draw = gpu.draw({ shader: DRAW_SHADER, label: "frame-gpu-driven" });

  gpu.frame((frame) => frame.pass(target, (p) => p.draw(draw, { indirect: args })));

  expect(ops).toEqual([["setPipeline"], ["drawIndirect", gpuBufferOf(args), 0]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("bundles record and replay indirect draws end-to-end", async () => {
  const gpu = await init();
  const bundleOps = spyBundleEncoderOps(gpu.device.gpu);
  const target = gpu.target({ size: [2, 2] });
  const geometry = gpu.geometry({ buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1, 2]) });
  const drawArgs = gpu.storage(16, { indirect: true });
  const indexedArgs = gpu.storage(20, { indirect: true });
  const plain = gpu.draw({ shader: DRAW_SHADER, label: "bundled-gpu-driven" });
  const indexed = gpu.draw({ shader: MESH_SHADER, label: "bundled-indexed-gpu-driven", geometry });

  const bundle = gpu.bundle({ target, label: "gpuDriven" }, (b) => {
    b.draw(plain, { indirect: drawArgs });
    b.draw(indexed, { indirect: { buffer: indexedArgs, offset: 0 } });
  });

  expect(bundleOps).toEqual([
    ["setPipeline"], ["drawIndirect", gpuBufferOf(drawArgs), 0],
    ["setPipeline"], ["setVertexBuffer", 0], ["setIndexBuffer", geometry.indexBuffer, "uint16"], ["drawIndexedIndirect", gpuBufferOf(indexedArgs), 0],
  ]);
  expect(() => gpu.frame((f) => f.pass(target, (p) => p.bundles(bundle)))).not.toThrow();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("indirect draws require a buffer created with the indirect flag", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const args = gpu.storage(16);
  const draw = gpu.draw({ shader: DRAW_SHADER, label: "no-usage" });

  expect(() => draw.draw({ target, indirect: args })).toThrowError(/VGPU-INDIRECT-INVALID|gpu\.storage\(16, \{ indirect: true \}\)/);
  gpu.dispose();
});

test("indirect offsets must be 4-aligned non-negative integers", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const args = gpu.storage(64, { indirect: true });
  const draw = gpu.draw({ shader: DRAW_SHADER, label: "bad-offset" });
  const expectInvalid = (offset: number): void => {
    expect(() => draw.draw({ target, indirect: { buffer: args, offset } })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  };

  expectInvalid(6);
  expectInvalid(2);
  expectInvalid(-4);
  expectInvalid(1.5);
  expect(() => draw.draw({ target, indirect: { buffer: args, offset: 8 } })).not.toThrow();
  gpu.dispose();
});

test("indirect arguments must fit: 16 bytes for drawIndirect, 20 for drawIndexedIndirect, 12 for dispatchWorkgroupsIndirect", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const geometry = gpu.geometry({ buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1, 2]) });
  const draw = gpu.draw({ shader: DRAW_SHADER, label: "too-small" });
  const indexed = gpu.draw({ shader: MESH_SHADER, label: "too-small-indexed", geometry });
  const sim = gpu.compute(COMPUTE_SHADER, { label: "too-small-sim" });

  // drawIndirect reads 4 u32s: a 12-byte buffer, or 16 bytes at offset 4, cannot hold them.
  expect(() => draw.draw({ target, indirect: gpu.storage(12, { indirect: true }) })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  expect(() => draw.draw({ target, indirect: { buffer: gpu.storage(16, { indirect: true }), offset: 4 } })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  // drawIndexedIndirect reads 5 32-bit values: 16 bytes are not enough.
  expect(() => indexed.draw({ target, indirect: gpu.storage(16, { indirect: true }) })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  expect(() => indexed.draw({ target, indirect: gpu.storage(20, { indirect: true }) })).not.toThrow();
  // dispatchWorkgroupsIndirect reads 3 u32s: 8 bytes are not enough.
  expect(() => sim.dispatch({ indirect: gpu.storage(8, { indirect: true }) })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  expect(() => sim.dispatch({ indirect: gpu.storage(12, { indirect: true }) })).not.toThrow();
  gpu.dispose();
});

test("malformed indirect values fail with VGPU-INDIRECT-INVALID", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const draw = gpu.draw({ shader: DRAW_SHADER, label: "bad-shape" });
  const expectInvalid = (indirect: unknown): void => {
    expect(() => draw.draw({ target, indirect: indirect as never })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  };

  expectInvalid(16);
  expectInvalid("args");
  expectInvalid(null);
  expectInvalid({});
  expectInvalid({ buffer: {} });
  gpu.dispose();
});

test("indirect conflicts with CPU-side counts in the same draw call", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const args = gpu.storage(64, { indirect: true });
  const draw = gpu.draw({ shader: DRAW_SHADER, label: "conflict" });
  const conflicts = [{ vertices: 3 }, { indices: 3 }, { instances: 2 }, { firstVertex: 1 }, { firstIndex: 1 }, { baseVertex: 1 }, { firstInstance: 1 }] as const;

  for (const conflict of conflicts) {
    expect(() => draw.draw({ target, indirect: args, ...conflict })).toThrowError(/VGPU-INDIRECT-INVALID|ignored/);
  }
  // Constructor-level defaults are not per-call conflicts; only same-call counts throw.
  expect(() => gpu.draw({ shader: DRAW_SHADER, label: "defaults-ok", instances: 2 }).draw({ target, indirect: args })).not.toThrow();
  gpu.dispose();
});

test("compute dispatch indirect emits dispatchWorkgroupsIndirect and keeps positional dispatch unchanged", async () => {
  const gpu = await init();
  const ops = spyComputePassOps(gpu.device.gpu);
  const args = gpu.storage(24, { indirect: true });
  const sim = gpu.compute(COMPUTE_SHADER, { label: "sim" });

  sim.dispatch(4);
  sim.dispatch(2, 3, 4);
  sim.dispatch({ indirect: args });
  sim.dispatch({ indirect: { buffer: args, offset: 12 } });

  expect(ops).toEqual([
    ["setPipeline"], ["dispatchWorkgroups", 4, 1, 1],
    ["setPipeline"], ["dispatchWorkgroups", 2, 3, 4],
    ["setPipeline"], ["dispatchWorkgroupsIndirect", gpuBufferOf(args), 0],
    ["setPipeline"], ["dispatchWorkgroupsIndirect", gpuBufferOf(args), 12],
  ]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("compute indirect validation mirrors the draw rules", async () => {
  const gpu = await init();
  const sim = gpu.compute(COMPUTE_SHADER, { label: "sim-invalid" });

  expect(() => sim.dispatch({ indirect: gpu.storage(12) })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  expect(() => sim.dispatch({ indirect: { buffer: gpu.storage(64, { indirect: true }), offset: 6 } })).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  // Explicit workgroup counts alongside indirect are dead options.
  expect(() => (sim.dispatch as (x: unknown, y?: number) => void)({ indirect: gpu.storage(12, { indirect: true }) }, 2)).toThrowError(/VGPU-INDIRECT-INVALID|Invalid indirect/);
  gpu.dispose();
});

type PassOp = readonly [name: string, ...args: unknown[]];

function spyRenderPassOps(device: GPUDevice): PassOp[] {
  const ops: PassOp[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        return spyRenderCommands(ops, originalBeginRenderPass(renderPassDescriptor));
      },
    } as GPUCommandEncoder;
  });
  return ops;
}

function spyBundleEncoderOps(device: GPUDevice): PassOp[] {
  const ops: PassOp[] = [];
  const originalCreateRenderBundleEncoder = device.createRenderBundleEncoder.bind(device);
  vi.spyOn(device, "createRenderBundleEncoder").mockImplementation((descriptor: GPURenderBundleEncoderDescriptor) => {
    return spyRenderCommands(ops, originalCreateRenderBundleEncoder(descriptor));
  });
  return ops;
}

function spyRenderCommands<T extends Pick<GPURenderPassEncoder, "setPipeline" | "setVertexBuffer" | "setIndexBuffer" | "draw" | "drawIndexed" | "drawIndirect" | "drawIndexedIndirect">>(ops: PassOp[], encoder: T): T {
  return {
    ...encoder,
    setPipeline(pipeline: GPURenderPipeline) { ops.push(["setPipeline"]); encoder.setPipeline(pipeline); },
    setVertexBuffer(...args: Parameters<GPURenderPassEncoder["setVertexBuffer"]>) { ops.push(["setVertexBuffer", args[0]]); encoder.setVertexBuffer(...args); },
    setIndexBuffer(...args: Parameters<GPURenderPassEncoder["setIndexBuffer"]>) { ops.push(["setIndexBuffer", args[0], args[1]]); encoder.setIndexBuffer(...args); },
    draw(...args: Parameters<GPURenderPassEncoder["draw"]>) { ops.push(["draw"]); encoder.draw(...args); },
    drawIndexed(...args: Parameters<GPURenderPassEncoder["drawIndexed"]>) { ops.push(["drawIndexed"]); encoder.drawIndexed(...args); },
    drawIndirect(buffer: GPUBuffer, offset: number) { ops.push(["drawIndirect", buffer, offset]); encoder.drawIndirect(buffer, offset); },
    drawIndexedIndirect(buffer: GPUBuffer, offset: number) { ops.push(["drawIndexedIndirect", buffer, offset]); encoder.drawIndexedIndirect(buffer, offset); },
  } as T;
}

function spyComputePassOps(device: GPUDevice): PassOp[] {
  const ops: PassOp[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginComputePass = encoder.beginComputePass.bind(encoder);
    return {
      ...encoder,
      beginComputePass(computePassDescriptor?: GPUComputePassDescriptor): GPUComputePassEncoder {
        const pass = originalBeginComputePass(computePassDescriptor);
        return {
          ...pass,
          setPipeline(pipeline: GPUComputePipeline) { ops.push(["setPipeline"]); pass.setPipeline(pipeline); },
          dispatchWorkgroups(x: number, y?: number, z?: number) { ops.push(["dispatchWorkgroups", x, y, z]); pass.dispatchWorkgroups(x, y, z); },
          dispatchWorkgroupsIndirect(buffer: GPUBuffer, offset: number) { ops.push(["dispatchWorkgroupsIndirect", buffer, offset]); pass.dispatchWorkgroupsIndirect(buffer, offset); },
        } as GPUComputePassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return ops;
}
