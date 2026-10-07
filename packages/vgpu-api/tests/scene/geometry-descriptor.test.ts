import { afterEach, expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation, init, VGPUError, geometry } from "../../src/mock.ts";
import { geometry as geometryOf } from "../../src/scene/geometry-descriptor.ts";

const INDEX_USAGE = 16;

afterEach(() => { vi.restoreAllMocks(); });

function meshErrorOf(fn: () => unknown): VGPUError {
  try { fn(); } catch (error) { if (error instanceof VGPUError) return error; throw error; }
  throw new Error("Expected a VGPUError");
}

function positions() {
  return { data: new Float32Array(12), attributes: { position: { format: "float32x2" as const, location: 0 } } };
}

function mockBytes(buffer: GPUBuffer | undefined): number[] {
  return [...(buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes];
}

function bytesOf(view: ArrayBufferView): number[] {
  return [...new Uint8Array(view.buffer, view.byteOffset, view.byteLength)];
}

/** Payloads handed to the native `writeBuffer` for index buffers; the mock does not enforce its 4-byte rule. */
function spyIndexWrites(gpu: Awaited<ReturnType<typeof init>>): () => ArrayBufferView[] {
  const writeBuffer = vi.spyOn(gpu.device.gpu.queue, "writeBuffer");
  return () => writeBuffer.mock.calls
    .filter(([buffer]) => (buffer.usage & INDEX_USAGE) !== 0)
    .map(([, , data]) => data as ArrayBufferView);
}

test("geometry(gpu, ...) normalizes record attributes, derives counts, and freezes slice layout identity", async () => {
  const gpu = await init();
  try {
    const vertices = new Float32Array([
      0, 0, 1, 1, 7, 0,
      1, 0, 1, 1, 8, 0,
    ]);
    const geo = geometry(gpu, {
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

    expect(geo.vertexCount).toBe(2);
    expect(geo.indexCount).toBe(2);
    expect(geo.indexFormat).toBe("uint16");
    expect(geo.vertexBufferLayouts).toEqual([{ arrayStride: 24, attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "float32x2" },
      { shaderLocation: 2, offset: 16, format: "float32" },
    ] }]);

    const slice = geo.slice({ firstIndex: 1, indexCount: 1, baseVertex: 2, instanceCount: 3 });
    expect(slice.vertexBufferLayouts).toBe(geo.vertexBufferLayouts);
    expect(slice.vertexBuffers).toBe(geo.vertexBuffers);
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

test("geometry(gpu, ...) derives tight auto stride, stepMode instance count, and rejects invalid layouts", async () => {
  const gpu = await init();
  try {
    const instances = geometry(gpu, { buffers: [{
      stepMode: "instance",
      data: new Float32Array([0, 0, 1, 1, 2, 2]),
      attributes: { pos: { format: "float32x2", location: 0 } },
    }] });
    expect(instances.vertexBufferLayouts[0]).toMatchObject({ arrayStride: 8, stepMode: "instance" });
    expect(instances.instanceCount).toBe(3);

    expect(() => geometry(gpu, { buffers: [{ data: new Float32Array([1, 2, 3, 4]), attributes: { pos: { format: "float32x3", location: 0 } } }] }))
      .toThrowError(/VGPU-MESH-DATA-MISALIGNED/);
    expect(() => geometry(gpu, { buffers: [{ data: new Float32Array([1, 2]), attributes: { 0: { format: "float32x2", location: 0 } } }] }))
      .toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(() => geometry(gpu, { buffers: [{ data: new Float32Array([1, 2, 3, 4]), attributes: { a: { format: "float32x2", location: 0 }, b: { format: "float32x2", location: 0 } } }] }))
      .toThrowError(/VGPU-MESH-LOCATION-CONFLICT/);
  } finally {
    gpu.dispose();
  }
});

test("geometry(gpu, ...) validates locations, enums, and tight auto-stride eagerly", async () => {
  const gpu = await init();
  try {
    const base = { data: new Float32Array([0]), attributes: { value: { format: "float32" as const, location: 0 } } };
    for (const location of [-1, 1.5, Number.NaN, gpu.device.gpu.limits.maxVertexAttributes]) {
      expect(() => geometry(gpu, { buffers: [{ ...base, attributes: { value: { format: "float32", location } } }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    }
    expect(() => geometry(gpu, { topology: "bogus" as GPUPrimitiveTopology, buffers: [base] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(() => geometry(gpu, { buffers: [{ ...base, stepMode: "bogus" as GPUVertexStepMode }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    for (const format of ["float16", "float16x3", "unorm8x3", "uint8x3"] as GPUVertexFormat[]) {
      expect(() => geometry(gpu, { buffers: [{ data: new Uint8Array(12), attributes: { value: { format, location: 0 } } }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    }
    expect(() => geometry(gpu, { buffers: [{ data: new Float32Array(5), attributes: { value: { format: "float32", offset: 16, location: 0 } } }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    const padded = geometry(gpu, { buffers: [{ data: new Float32Array(5), stride: 20, attributes: { value: { format: "float32", offset: 16, location: 0 } } }] });
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
    expect(() => geometry(gpu, { buffers: [raw] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(geometry(gpu, { buffers: [raw], vertexCount: 3 }).vertexCount).toBe(3);
    const owned = { data: new Float32Array(6), attributes: { position: { format: "float32x2" as const, location: 0 } } };
    const hybridRaw = { buffer: vertex, attributes: { uv: { format: "float32x2" as const, location: 1 } } };
    expect(geometry(gpu, { buffers: [owned, hybridRaw] }).vertexCount).toBe(3);
    const instances = [owned, hybridRaw].map((buffer) => ({ ...buffer, stepMode: "instance" as const }));
    expect(geometry(gpu, { buffers: instances }).instanceCount).toBe(3);
    expect(() => geometry(gpu, { buffers: [{ ...hybridRaw, stepMode: "instance" }] })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(() => geometry(gpu, { buffers: [raw], vertexCount: 3, indexBuffer: index })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(() => geometry(gpu, { buffers: [raw], vertexCount: 3, indexBuffer: index, indexFormat: "uint16" })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    expect(geometry(gpu, { buffers: [raw], vertexCount: 3, indexBuffer: index, indexFormat: "uint16", indexCount: 4 }).indexCount).toBe(4);
  } finally {
    gpu.dispose();
  }
});

test("owned counts cannot exceed data capacity and geometry layout properties are immutable", async () => {
  const gpu = await init();
  try {
    const descriptor = { buffers: [{ data: new Float32Array([0, 0]), attributes: { pos: { format: "float32x2" as const, location: 0 } } }] };
    expect(() => geometry(gpu, { ...descriptor, vertexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => geometry(gpu, { ...descriptor, indices: new Uint16Array([0, 0]), indexCount: 3 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => geometry(gpu, { ...descriptor, indices: new Uint16Array([0, 0]), indexFormat: "uint32" })).toThrowError(/VGPU-MESH-LAYOUT-INVALID/);
    const planar = [{ data: new Float32Array(6), attributes: { pos: { format: "float32x2" as const, location: 0 } } }, { data: new Float32Array(2), attributes: { uv: { format: "float32x2" as const, location: 1 } } }];
    expect(geometry(gpu, { buffers: planar }).vertexCount).toBe(1);
    expect(() => geometry(gpu, { buffers: planar, vertexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    const instances = planar.map((buffer) => ({ ...buffer, stepMode: "instance" as const }));
    expect(geometry(gpu, { buffers: instances }).instanceCount).toBe(1);
    expect(() => geometry(gpu, { buffers: instances, instanceCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    const geo = geometry(gpu, descriptor);
    expect(() => { (geo as { topology: string }).topology = "line-list"; }).toThrow(TypeError);
    expect(geo.topology).toBe("triangle-list");
  } finally {
    gpu.dispose();
  }
});

test("geometry writes enforce WebGPU alignment and stay structured after destroy", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, { buffers: [{ data: new Float32Array([0, 0]), attributes: { pos: { format: "float32x2", location: 0 } } }], indices: new Uint16Array([0, 1]) });
    expect(() => geo.write(new Uint8Array(2))).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => geo.write(new Uint32Array([1]), 2)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => geo.writeIndices(new Uint16Array([0]), 0)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    geo.destroy();
    expect(() => geo.write(new Uint32Array([1]))).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => geo.writeIndices(new Uint32Array([1]))).toThrowError(/VGPU-MESH-WRITE-RANGE/);
  } finally {
    gpu.dispose();
  }
});

test("geometry construction-time error codes include actionable fix hints", async () => {
  const gpu = await init();
  try {
    const buffer = () => ({ data: new Float32Array([0, 0]), attributes: { pos: { format: "float32x2" as const, location: 0 } } });
    const valid = geometry(gpu, { buffers: [buffer()] });
    const errors = [
      meshErrorOf(() => geometry(gpu, { buffers: [{ ...buffer(), stride: 3 }] })),
      meshErrorOf(() => geometry(gpu, { buffers: Array.from({ length: 9 }, buffer) })),
      meshErrorOf(() => geometry(gpu, { buffers: [{ data: new Float32Array(4), attributes: { a: { format: "float32x2", location: 0 }, b: { format: "float32x2", location: 0 } } }] })),
      meshErrorOf(() => geometry(gpu, { buffers: [{ data: new Float32Array(3), attributes: { pos: { format: "float32x2", location: 0 } } }] })),
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

test("geometry writes are range checked and slices validate indexed/non-indexed direction eagerly", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, { buffers: [{ data: new Float32Array([0, 0, 1, 1]), attributes: { pos: { format: "float32x2", location: 0 } } }] });
    expect(() => geo.write(new Float32Array([1]), 16)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
    expect(() => geo.slice({ firstIndex: 0, indexCount: 1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => geo.slice({ firstVertex: 1, vertexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);

    const indexed = geometry(gpu, { buffers: [{ data: new Float32Array([0, 0, 1, 1]), attributes: { pos: { format: "float32x2", location: 0 } } }], indices: [0, 1] });
    expect(() => indexed.slice({ firstVertex: 0, vertexCount: 1 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => indexed.slice({ firstIndex: 1, indexCount: 2 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
    expect(() => indexed.writeIndices(new Uint32Array([0]), 8)).toThrowError(/VGPU-MESH-WRITE-RANGE/);
  } finally {
    gpu.dispose();
  }
});

// --- initial index uploads (#490) -------------------------------------------------------------

test.each([[1, 4], [3, 8], [5, 12]])("an odd-length Uint16Array of %i indices uploads zero-padded to %i bytes", async (length, size) => {
  const gpu = await init();
  const indexWrites = spyIndexWrites(gpu);
  try {
    const source = Uint16Array.from({ length }, (_, i) => i + 1);
    const geo = geometry(gpu, { buffers: [positions()], indices: source });

    expect(geo.indexCount).toBe(length);
    expect(geo.indexFormat).toBe("uint16");
    expect(geo.indexBuffer?.size).toBe(size);
    const descriptor = getMockGPUDeviceInstrumentation(gpu.device.gpu).createBufferDescriptors.find((desc) => (desc.usage & INDEX_USAGE) !== 0);
    expect(descriptor?.size).toBe(size);
    const writes = indexWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.byteLength).toBe(size);
    expect(writes[0]!.byteLength % 4).toBe(0);
    expect(mockBytes(geo.indexBuffer)).toEqual([...bytesOf(source), 0, 0]);
  } finally {
    gpu.dispose();
  }
});

test("padding is not logical index capacity: writes and counts stay bounded by the source array", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, { buffers: [positions()], indices: new Uint16Array([0, 1, 2]) });

    expect(meshErrorOf(() => geo.writeIndices(new Uint16Array([0, 1, 2, 0]))).code).toBe("VGPU-MESH-WRITE-RANGE");
    expect(meshErrorOf(() => geo.writeIndices(new Uint16Array([0, 1]), 4)).code).toBe("VGPU-MESH-WRITE-RANGE");
    expect(() => geo.writeIndices(new Uint16Array([2, 1]), 0)).not.toThrow();
    expect(mockBytes(geo.indexBuffer)).toEqual(bytesOf(new Uint16Array([2, 1, 2, 0])));
    expect(meshErrorOf(() => geometry(gpu, { buffers: [positions()], indices: new Uint16Array([0, 1, 2]), indexCount: 4 })).code).toBe("VGPU-MESH-RANGE-INVALID");
  } finally {
    gpu.dispose();
  }
});

test("an even-length array with an explicit indexCount keeps every drawn index rewritable", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, { buffers: [positions()], indices: new Uint16Array([0, 1, 2, 0]), indexCount: 3 });

    expect(geo.indexCount).toBe(3);
    expect(() => geo.writeIndices(new Uint16Array([2, 1, 0, 0]))).not.toThrow();
    expect(mockBytes(geo.indexBuffer)).toEqual(bytesOf(new Uint16Array([2, 1, 0, 0])));
  } finally {
    gpu.dispose();
  }
});

test("index subarrays upload only their own bytes, padded or not", async () => {
  const gpu = await init();
  try {
    const backing = Uint16Array.of(9, 0, 1, 2, 8);
    const odd = backing.subarray(1, 4);
    expect(odd.byteOffset).toBe(2);
    const oddGeo = geometry(gpu, { buffers: [positions()], indices: odd });
    expect(oddGeo.indexCount).toBe(3);
    expect(oddGeo.indexBuffer?.size).toBe(8);
    expect(mockBytes(oddGeo.indexBuffer)).toEqual(bytesOf(new Uint16Array([0, 1, 2, 0])));

    const aligned = backing.subarray(2, 4);
    expect(aligned.byteOffset).toBe(4);
    const alignedGeo = geometry(gpu, { buffers: [positions()], indices: aligned });
    expect(alignedGeo.indexCount).toBe(2);
    expect(alignedGeo.indexBuffer?.size).toBe(4);
    expect(mockBytes(alignedGeo.indexBuffer)).toEqual(bytesOf(new Uint16Array([1, 2])));

    const wide = Uint32Array.of(9, 0, 1, 8).subarray(1, 3);
    const wideGeo = geometry(gpu, { buffers: [positions()], indices: wide });
    expect(wideGeo.indexFormat).toBe("uint32");
    expect(wideGeo.indexCount).toBe(2);
    expect(mockBytes(wideGeo.indexBuffer)).toEqual(bytesOf(new Uint32Array([0, 1])));
  } finally {
    gpu.dispose();
  }
});

test("empty and 4-byte-aligned index arrays keep their size and upload the caller's array directly", async () => {
  const gpu = await init();
  const indexWrites = spyIndexWrites(gpu);
  try {
    for (const empty of [new Uint16Array(0), new Uint32Array(0)]) {
      const geo = geometry(gpu, { buffers: [positions()], indices: empty });
      expect(geo.indexCount).toBe(0);
      expect(geo.indexBuffer?.size).toBe(4);
    }
    const aligned = [new Uint16Array([0, 1]), new Uint16Array([0, 1, 2, 3]), new Uint16Array([0, 1, 2, 3, 4, 5]), new Uint32Array([0]), new Uint32Array([0, 1, 2])];
    for (const indices of aligned) {
      const before = indexWrites().length;
      const geo = geometry(gpu, { buffers: [positions()], indices });
      expect(geo.indexCount).toBe(indices.length);
      expect(geo.indexFormat).toBe(indices instanceof Uint16Array ? "uint16" : "uint32");
      expect(geo.indexBuffer?.size).toBe(indices.byteLength);
      expect(indexWrites().slice(before)).toEqual([indices]);
      expect(indexWrites()[before]).toBe(indices);
    }
    expect(geometry(gpu, { buffers: [positions()], indices: [0, 1, 2] }).indexFormat).toBe("uint32");
  } finally {
    gpu.dispose();
  }
});

test("padding an initial index upload never mutates, detaches, or reads past the caller's view", async () => {
  const gpu = await init();
  try {
    const plain = new Uint16Array([3, 4, 5]);
    geometry(gpu, { buffers: [positions()], indices: plain });
    expect([...plain]).toEqual([3, 4, 5]);
    expect(plain.byteLength).toBe(6);
    expect(plain.buffer.byteLength).toBe(6);

    const backing = Uint16Array.of(9, 0, 1, 2, 8);
    const view = backing.subarray(1, 4);
    const backingBytes = bytesOf(backing);
    geometry(gpu, { buffers: [positions()], indices: view });
    expect([...view]).toEqual([0, 1, 2]);
    expect(view.length).toBe(3);
    expect(view.byteOffset).toBe(2);
    expect(view.byteLength).toBe(6);
    expect(bytesOf(backing)).toEqual(backingBytes);
    expect(backing.buffer.byteLength).toBe(10);
  } finally {
    gpu.dispose();
  }
});

test.each([["aligned", new Uint16Array([0, 1])], ["padded", new Uint16Array([0, 1, 2])]])("a failed %s initial index upload destroys the index buffer and rethrows", async (_, indices) => {
  const gpu = await init();
  try {
    const created: { usage: readonly string[] | undefined; destroy: ReturnType<typeof vi.fn> }[] = [];
    const createBuffer = gpu.device.createBuffer.bind(gpu.device);
    vi.spyOn(gpu.device, "createBuffer").mockImplementation((opts) => {
      const buffer = createBuffer(opts);
      created.push({ usage: opts.usage as readonly string[] | undefined, destroy: vi.spyOn(buffer, "destroy") as unknown as ReturnType<typeof vi.fn> });
      return buffer;
    });
    const failure = new Error("index upload failed");
    const writeBuffer = gpu.device.gpu.queue.writeBuffer.bind(gpu.device.gpu.queue);
    vi.spyOn(gpu.device.gpu.queue, "writeBuffer").mockImplementation((buffer, ...rest) => {
      if ((buffer.usage & INDEX_USAGE) !== 0) throw failure;
      writeBuffer(buffer, ...rest);
    });

    expect(() => geometry(gpu, { buffers: [positions()], indices })).toThrow(failure);
    const index = created.filter((buffer) => buffer.usage?.includes("index"));
    expect(index).toHaveLength(1);
    expect(index[0]!.destroy).toHaveBeenCalledTimes(1);
  } finally {
    gpu.dispose();
  }
});

test("odd vertex data and strides keep their named rejections without allocating", async () => {
  const gpu = await init();
  try {
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    const before = mock.calls.createBuffer;
    const misaligned = meshErrorOf(() => geometry(gpu, { buffers: [{ data: new Uint16Array(3), attributes: { uv: { format: "float16x2", location: 0 } } }] }));
    expect(misaligned.code).toBe("VGPU-MESH-DATA-MISALIGNED");
    expect(misaligned.fix).toBeTruthy();
    const stride = meshErrorOf(() => geometry(gpu, { buffers: [{ data: new Uint16Array(3), stride: 6, attributes: { uv: { format: "float16x2", location: 0 } } }] }));
    expect(stride.code).toBe("VGPU-MESH-LAYOUT-INVALID");
    expect(stride.fix).toBeTruthy();
    expect(mock.calls.createBuffer).toBe(before);
  } finally {
    gpu.dispose();
  }
});

// --- gpu-first factory (T202-03) --------------------------------------------------------------

test("geometry(gpu, descriptor) builds the same layout as the facade and owns its buffers for the gpu's lifetime", async () => {
  const gpu = await init();
  const vertices = new Float32Array([0, 0, 1, 0, 0, 1]);
  const mesh = geometryOf(gpu, { label: "triangle", buffers: [{ data: vertices, attributes: { position: { format: "float32x2", location: 0 } } }] });

  expect(mesh.vertexCount).toBe(3);
  expect(mesh.vertexBufferLayouts).toEqual([{ arrayStride: 8, attributes: [{ format: "float32x2", offset: 0, shaderLocation: 0 }] }]);
  expect(() => mesh.write(vertices)).not.toThrow();

  // No explicit destroy(): the kernel destroys owned geometry buffers in the resource phase.
  gpu.dispose();
  expect(meshErrorOf(() => mesh.write(vertices)).code).toBe("VGPU-MESH-WRITE-RANGE");
});

test("destroying a geometry by hand releases its kernel registration, so dispose() is a no-op for it", async () => {
  const gpu = await init();
  const mesh = geometryOf(gpu, { buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }] });
  const destroyed: string[] = [];
  mesh.onDestroy(() => destroyed.push("geometry"));

  mesh.destroy();
  expect(destroyed).toEqual(["geometry"]);
  // The registration was dropped at destroy(), so teardown does not run the disposer a second time.
  gpu.dispose();
  expect(destroyed).toEqual(["geometry"]);
});

test("geometry(gpu, descriptor) borrows caller-owned buffers instead of allocating or destroying them", async () => {
  const gpu = await init();
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  const borrowed = gpu.device.gpu.createBuffer({ size: 24, usage: 32 | 8 });
  const before = mock.createBufferDescriptors.length;
  const mesh = geometryOf(gpu, { buffers: [{ buffer: borrowed, stride: 8, attributes: { position: { format: "float32x2", location: 0 } } }], vertexCount: 3 });

  expect(mock.createBufferDescriptors.length).toBe(before);
  expect(mesh.vertexBuffers).toEqual([borrowed]);
  // Writing a borrowed stream is rejected: vgpu never owned those bytes, so it never frees them either.
  expect(meshErrorOf(() => mesh.write(new Float32Array([1, 2]))).code).toBe("VGPU-MESH-WRITE-RANGE");
  expect(() => gpu.dispose()).not.toThrow();
});

test("geometry(gpu, descriptor) validates the gpu and keeps the mesh error codes", async () => {
  const gpu = await init();
  // Same validation pipeline as the facade: 16 bytes of data cannot be split into 12-byte vertices.
  expect(meshErrorOf(() => geometryOf(gpu, { buffers: [{ data: new Float32Array([1, 2, 3, 4]), attributes: { pos: { format: "float32x3", location: 0 } } }] })).code)
    .toBe("VGPU-MESH-DATA-MISALIGNED");
  expect(meshErrorOf(() => geometryOf(gpu, { topology: "bogus" as GPUPrimitiveTopology, buffers: [] })).code)
    .toBe("VGPU-MESH-LAYOUT-INVALID");
  gpu.dispose();
  expect(meshErrorOf(() => geometryOf(gpu, { buffers: [] }))).toMatchObject({ code: "VGPU-GPU-DISPOSED", where: "geometry" });
});
