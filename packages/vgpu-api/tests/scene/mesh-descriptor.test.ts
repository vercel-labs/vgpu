import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation, init, VGPUError } from "../../src/mock.ts";

function meshErrorOf(fn: () => unknown): VGPUError {
  try { fn(); } catch (error) { if (error instanceof VGPUError) return error; throw error; }
  throw new Error("Expected a VGPUError");
}

test("gpu.mesh normalizes record attributes, derives counts, and freezes slice layout identity", async () => {
  const gpu = await init();
  try {
    const vertices = new Float32Array([
      0, 0, 1, 1, 7, 0,
      1, 0, 1, 1, 8, 0,
    ]);
    const mesh = gpu.mesh({
      label: "led",
      buffers: [{
        data: vertices,
        stride: 24,
        attributes: {
          position: { format: "float32x2", location: 0 },
          local: { format: "float32x2", offset: 8, location: 1 },
          led_index: { format: "float32", offset: 16, location: 2 },
        },
      }],
      indices: new Uint16Array([0, 1]),
    });

    expect(mesh.vertexCount).toBe(2);
    expect(mesh.indexCount).toBe(2);
    expect(mesh.indexFormat).toBe("uint16");
    expect(mesh.vertexBufferLayouts).toEqual([{ arrayStride: 24, attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "float32x2" },
      { shaderLocation: 2, offset: 16, format: "float32" },
    ] }]);

    const slice = mesh.slice({ firstIndex: 1, indexCount: 1, baseVertex: 2, instanceCount: 3 });
    expect(slice.vertexBufferLayouts).toBe(mesh.vertexBufferLayouts);
    expect(slice.vertexBuffers).toBe(mesh.vertexBuffers);
    expect(slice.indexCount).toBe(1);
    expect(slice.firstIndex).toBe(1);
    expect(slice.baseVertex).toBe(2);
    expect(slice.instanceCount).toBe(3);

    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(mock.calls.createBuffer).toBe(2);
  } finally {
    gpu.dispose();
  }
});

test("gpu.mesh derives tight auto stride, stepMode instance count, and rejects invalid layouts", async () => {
  const gpu = await init();
  try {
    const instances = gpu.mesh({ buffers: [{
      stepMode: "instance",
      data: new Float32Array([0, 0, 1, 1, 2, 2]),
      attributes: { pos: { format: "float32x2", location: 0 } },
    }] });
    expect(instances.vertexBufferLayouts[0]).toMatchObject({ arrayStride: 8, stepMode: "instance" });
    expect(instances.instanceCount).toBe(3);

    expect(() => gpu.mesh({ buffers: [{ data: new Float32Array([1, 2, 3, 4]), attributes: { pos: { format: "float32x3", location: 0 } } }] }))
      .toThrowError(/VGPU-MESH-DATA-MISALIGNED/);
    expect(() => gpu.mesh({ buffers: [{ data: new Float32Array([1, 2]), attributes: { 0: { format: "float32x2", location: 0 } } }] }))
      .toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(() => gpu.mesh({ buffers: [{ data: new Float32Array([1, 2, 3, 4]), attributes: { a: { format: "float32x2", location: 0 }, b: { format: "float32x2", location: 0 } } }] }))
      .toThrowError(/VGPU-MESH-LOCATION-CONFLICT/);
  } finally {
    gpu.dispose();
  }
});

test("gpu.mesh validates locations, enums, and tight auto-stride eagerly", async () => {
  const gpu = await init();
  try {
    const base = { data: new Float32Array([0]), attributes: { value: { format: "float32" as const, location: 0 } } };
    for (const location of [-1, 1.5, Number.NaN, gpu.device.gpu.limits.maxVertexAttributes]) {
      expect(() => gpu.mesh({ buffers: [{ ...base, attributes: { value: { format: "float32", location } } }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    }
    expect(() => gpu.mesh({ topology: "bogus" as GPUPrimitiveTopology, buffers: [base] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(() => gpu.mesh({ buffers: [{ ...base, stepMode: "bogus" as GPUVertexStepMode }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    for (const format of ["float16", "float16x3", "unorm8x3", "uint8x3"] as GPUVertexFormat[]) {
      expect(() => gpu.mesh({ buffers: [{ data: new Uint8Array(12), attributes: { value: { format, location: 0 } } }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    }
    expect(() => gpu.mesh({ buffers: [{ data: new Float32Array(5), attributes: { value: { format: "float32", offset: 16, location: 0 } } }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    const padded = gpu.mesh({ buffers: [{ data: new Float32Array(5), stride: 20, attributes: { value: { format: "float32", offset: 16, location: 0 } } }] });
    expect(padded.vertexBufferLayouts[0]?.arrayStride).toBe(20);
  } finally {
    gpu.dispose();
  }
});

test("caller-owned buffers require explicit counts and a complete index trio", async () => {
  const gpu = await init();
  try {
    const vertex = gpu.device.gpu.createBuffer({ size: 64, usage: 32 });
    const index = gpu.device.gpu.createBuffer({ size: 64, usage: 16 });
    const raw = { buffer: vertex, attributes: { pos: { format: "float32x2" as const, location: 0 } } };
    expect(() => gpu.mesh({ buffers: [raw] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(gpu.mesh({ buffers: [raw], vertexCount: 3 }).vertexCount).toBe(3);
    expect(() => gpu.mesh({ buffers: [raw], vertexCount: 3, indexBuffer: index })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(() => gpu.mesh({ buffers: [raw], vertexCount: 3, indexBuffer: index, indexFormat: "uint16" })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(gpu.mesh({ buffers: [raw], vertexCount: 3, indexBuffer: index, indexFormat: "uint16", indexCount: 4 }).indexCount).toBe(4);
  } finally {
    gpu.dispose();
  }
});

test("owned counts cannot exceed data capacity and mesh layout properties are immutable", async () => {
  const gpu = await init();
  try {
    const descriptor = { buffers: [{ data: new Float32Array([0, 0]), attributes: { pos: { format: "float32x2" as const, location: 0 } } }] };
    expect(() => gpu.mesh({ ...descriptor, vertexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => gpu.mesh({ ...descriptor, indices: new Uint16Array([0, 0]), indexCount: 3 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => gpu.mesh({ ...descriptor, indices: new Uint16Array([0, 0]), indexFormat: "uint32" })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    const planar = [{ data: new Float32Array(6), attributes: { pos: { format: "float32x2" as const, location: 0 } } }, { data: new Float32Array(2), attributes: { uv: { format: "float32x2" as const, location: 1 } } }];
    expect(gpu.mesh({ buffers: planar }).vertexCount).toBe(1);
    expect(() => gpu.mesh({ buffers: planar, vertexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    const instances = planar.map((buffer) => ({ ...buffer, stepMode: "instance" as const }));
    expect(gpu.mesh({ buffers: instances }).instanceCount).toBe(1);
    expect(() => gpu.mesh({ buffers: instances, instanceCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    const mesh = gpu.mesh(descriptor);
    expect(() => { (mesh as { topology: string }).topology = "line-list"; }).toThrow(TypeError);
    expect(mesh.topology).toBe("triangle-list");
  } finally {
    gpu.dispose();
  }
});

test("mesh writes enforce WebGPU alignment and stay structured after destroy", async () => {
  const gpu = await init();
  try {
    const mesh = gpu.mesh({ buffers: [{ data: new Float32Array([0, 0]), attributes: { pos: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1]) });
    expect(() => mesh.write(new Uint8Array(2))).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => mesh.write(new Uint32Array([1]), 2)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => mesh.writeIndices(new Uint16Array([0]), 0)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    mesh.destroy();
    expect(() => mesh.write(new Uint32Array([1]))).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => mesh.writeIndices(new Uint32Array([1]))).toThrowError(/VGPU-MESH-WRITE-RANGE/);
  } finally {
    gpu.dispose();
  }
});

test("mesh construction-time error codes include actionable fix hints", async () => {
  const gpu = await init();
  try {
    const buffer = () => ({ data: new Float32Array([0, 0]), attributes: { pos: { format: "float32x2" as const, location: 0 } } });
    const valid = gpu.mesh({ buffers: [buffer()] });
    const errors = [
      meshErrorOf(() => gpu.mesh({ buffers: [{ ...buffer(), stride: 3 }] })),
      meshErrorOf(() => gpu.mesh({ buffers: Array.from({ length: 9 }, buffer) })),
      meshErrorOf(() => gpu.mesh({ buffers: [{ data: new Float32Array(4), attributes: { a: { format: "float32x2", location: 0 }, b: { format: "float32x2", location: 0 } } }] })),
      meshErrorOf(() => gpu.mesh({ buffers: [{ data: new Float32Array(3), attributes: { pos: { format: "float32x2", location: 0 } } }] })),
      meshErrorOf(() => valid.slice({ firstVertex: 1, vertexCount: 1 })),
      meshErrorOf(() => valid.write(new Uint8Array(2))),
    ];
    expect(errors.map((error) => error.code)).toEqual([
      "VGPU-MESH-LAYOUT-INVALID",
      "VGPU-MESH-LIMIT-EXCEEDED",
      "VGPU-MESH-LOCATION-CONFLICT",
      "VGPU-MESH-DATA-MISALIGNED",
      "VGPU-MESH-RANGE-INVALID",
      "VGPU-MESH-WRITE-RANGE",
    ]);
    for (const error of errors) expect(error.fix).toBeTruthy();
  } finally {
    gpu.dispose();
  }
});

test("mesh writes are range checked and slices validate indexed/non-indexed direction eagerly", async () => {
  const gpu = await init();
  try {
    const mesh = gpu.mesh({ buffers: [{ data: new Float32Array([0, 0, 1, 1]), attributes: { pos: { format: "float32x2", location: 0 } } }] });
    expect(() => mesh.write(new Float32Array([1]), 16)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => mesh.slice({ firstIndex: 0, indexCount: 1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => mesh.slice({ firstVertex: 1, vertexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);

    const indexed = gpu.mesh({ buffers: [{ data: new Float32Array([0, 0, 1, 1]), attributes: { pos: { format: "float32x2", location: 0 } } }], indices: [0, 1] });
    expect(() => indexed.slice({ firstVertex: 0, vertexCount: 1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => indexed.slice({ firstIndex: 1, indexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => indexed.writeIndices(new Uint32Array([0]), 8)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
  } finally {
    gpu.dispose();
  }
});
