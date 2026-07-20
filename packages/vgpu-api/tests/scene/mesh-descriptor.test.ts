import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation, init } from "../../src/mock.ts";

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
