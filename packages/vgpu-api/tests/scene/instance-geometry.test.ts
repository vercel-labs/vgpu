import { prepareShader } from "@vgpu/wgsl/prepare";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { expect, test, vi } from "vitest";
import { bundle, draw, frame, init, storage, target, VGPUError } from "../../src/mock.ts";
import { geometry } from "../../src/scene/geometry-descriptor.ts";
import { instanceGeometry } from "../../src/scene/instance-geometry.ts";
import { getInstanceProtocol } from "../../src/scene/instance-protocol.ts";
import { instances } from "../../src/scene/instances.ts";

const SHADER = `
struct VertexOut { @builtin(position) position: vec4f }
@vertex fn vs_main(
  @location(0) position: vec2f,
  @location(1) world0: vec4f,
  @location(2) world1: vec4f,
  @location(3) world2: vec4f,
  @location(4) world3: vec4f,
  @location(5) tint: vec3f,
  @location(6) kind: u32,
) -> VertexOut {
  var out: VertexOut;
  let world = mat4x4f(world0, world1, world2, world3);
  out.position = world * vec4f(position, 0.0, 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

function errorOf(run: () => unknown): VGPUError {
  try { run(); } catch (error) { if (error instanceof VGPUError) return error; throw error; }
  throw new Error("Expected a VGPUError");
}

test("instanceGeometry composes the base metadata with one packed instance stream", async () => {
  const gpu = await init();
  try {
    const mesh = geometry(gpu, {
      buffers: [
        { data: new Float32Array([-1, -1, 1, -1, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } },
        { data: new Float32Array([0, 0, 1, 0, 0.5, 1]), attributes: { uv: { format: "float32x2", location: 7 } } },
      ],
      indices: new Uint16Array([0, 1, 2]),
      topology: "triangle-strip",
    });
    const collection = instances({ capacity: 3, attributes: { tint: "float32x3", kind: "uint32" } });

    const bridge = instanceGeometry(gpu, collection, { mesh });

    expect(bridge.geometry.vertexBuffers.slice(0, 2)).toEqual(mesh.vertexBuffers);
    expect(bridge.geometry.indexBuffer).toBe(mesh.indexBuffer);
    expect(bridge.geometry.indexFormat).toBe("uint16");
    expect(bridge.geometry.indexCount).toBe(3);
    expect(bridge.geometry.vertexCount).toBe(3);
    expect(bridge.geometry.topology).toBe("triangle-strip");
    expect(bridge.geometry.vertexBufferLayouts).toEqual([
      { arrayStride: 8, attributes: [{ format: "float32x2", offset: 0, shaderLocation: 0 }] },
      { arrayStride: 8, attributes: [{ format: "float32x2", offset: 0, shaderLocation: 7 }] },
      { arrayStride: 80, stepMode: "instance", attributes: [
        { format: "float32x4", offset: 0, shaderLocation: 0 },
        { format: "float32x4", offset: 16, shaderLocation: 1 },
        { format: "float32x4", offset: 32, shaderLocation: 2 },
        { format: "float32x4", offset: 48, shaderLocation: 3 },
        { format: "float32x3", offset: 64, shaderLocation: 4 },
        { format: "uint32", offset: 76, shaderLocation: 5 },
      ] },
    ]);
    expect(getMockGPUDeviceInstrumentation(gpu.gpu).createBufferDescriptors.at(-1)).toMatchObject({ size: 240 });
  } finally {
    gpu.dispose();
  }
});

test("publish uploads dirty packed rows and leaves unchanged publications alone", async () => {
  const gpu = await init();
  try {
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array([-1, -1, 1, -1, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }] });
    const collection = instances({ capacity: 3, attributes: { tint: "float32x3", kind: "uint32" } });
    const first = collection.add({ tint: [0.25, 0.5, 0.75], kind: 7 });
    const second = collection.add({ tint: [1, 0, 0], kind: 9 });
    const bridge = instanceGeometry(gpu, collection, { mesh });
    const write = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    write.mockClear();

    expect(bridge.publish()).toBe(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[1]).toBe(0);
    expect((write.mock.calls[0]?.[2] as Uint8Array).byteLength).toBe(160);
    const uploaded = (bridge.geometry.vertexBuffers.at(-1) as GPUBuffer & { readonly __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
    expect(uploaded.slice(0, 160)).toEqual(getInstanceProtocol(collection).records.slice(0, 160));
    expect(bridge.publish()).toBe(2);
    expect(write).toHaveBeenCalledTimes(1);

    collection.set(second, { kind: 10 });
    expect(bridge.publish()).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[1]).toBe(80);
    expect((write.mock.calls[1]?.[2] as Uint8Array).byteLength).toBe(80);

    collection.remove(first);
    expect(collection.idAt(0)).toBe(second);
    expect(bridge.publish()).toBe(1);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[2]?.[1]).toBe(0);

    collection.remove(second);
    expect(bridge.publish()).toBe(0);
    expect(write).toHaveBeenCalledTimes(3);
  } finally {
    gpu.dispose();
  }
});

test("all instance formats retain declaration order, offsets, and scalar/vector GPU types", async () => {
  const gpu = await init();
  try {
    const mesh = geometry(gpu, { buffers: [], vertexCount: 3 });
    const attributes = {
      f1: "float32", f2: "float32x2", f3: "float32x3", f4: "float32x4",
      i1: "sint32", i2: "sint32x2", i3: "sint32x3", i4: "sint32x4",
      u1: "uint32", u2: "uint32x2", u3: "uint32x3", u4: "uint32x4",
    } as const;
    const collection = instances({ capacity: 1, attributes });
    const bridge = instanceGeometry(gpu, collection, { mesh });
    const layout = bridge.geometry.vertexBufferLayouts[0]!;
    expect(layout.arrayStride).toBe(184);
    expect([...layout.attributes].map(({ format, offset }) => [format, offset])).toEqual([
      ["float32x4", 0], ["float32x4", 16], ["float32x4", 32], ["float32x4", 48],
      ["float32", 64], ["float32x2", 68], ["float32x3", 76], ["float32x4", 88],
      ["sint32", 104], ["sint32x2", 108], ["sint32x3", 116], ["sint32x4", 128],
      ["uint32", 144], ["uint32x2", 148], ["uint32x3", 156], ["uint32x4", 168],
    ]);
  } finally {
    gpu.dispose();
  }
});

test("composition failure destroys only its newly allocated instance buffer", async () => {
  const gpu = await init();
  try {
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { position: "float32x2" } }] });
    const collection = instances({ capacity: 1 });
    const original = gpu.device.createBuffer.bind(gpu.device);
    let destroy: ReturnType<typeof vi.fn> | undefined;
    vi.spyOn(gpu.device, "createBuffer").mockImplementation((options) => {
      const created = original(options);
      destroy = vi.fn(created.destroy.bind(created));
      vi.spyOn(created, "destroy").mockImplementation(destroy);
      vi.spyOn(created, "write").mockImplementation(() => { throw new Error("initial upload failed"); });
      return created;
    });

    expect(() => instanceGeometry(gpu, collection, { mesh })).toThrow("initial upload failed");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(() => mesh.write(new Float32Array(6))).not.toThrow();
  } finally {
    vi.restoreAllMocks();
    gpu.dispose();
  }
});

test("instance inputs stay name-matched while omitted explicit base locations retain legacy behavior", async () => {
  const gpu = await init();
  try {
    const collection = instances({ capacity: 1, attributes: { tint: "float32x3", kind: "uint32" } });
    const explicit = geometry(gpu, { buffers: [{
      data: new Float32Array(12),
      stride: 16,
      attributes: {
        position: { format: "float32x2", location: 0 },
        legacyUv: { format: "float32x2", offset: 8, location: 7 },
      },
    }] });
    const bridge = instanceGeometry(gpu, collection, { mesh: explicit });
    expect(() => draw(gpu, { shader: prepareShader(SHADER), geometry: bridge.geometry })).not.toThrow();

    const missingKind = SHADER.replace("  @location(6) kind: u32,\n", "").replace("kind", "0u");
    expect(() => draw(gpu, { shader: prepareShader(missingKind), geometry: bridge.geometry })).toThrowError(/VGPU-MESH-ATTRIBUTE-UNMATCHED/);

    const named = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { unusedBase: "float32x2" } }] });
    const namedBridge = instanceGeometry(gpu, collection, { mesh: named });
    expect(() => draw(gpu, { shader: prepareShader(SHADER), geometry: namedBridge.geometry })).toThrowError(/VGPU-MESH-ATTRIBUTE-UNMATCHED/);
  } finally {
    gpu.dispose();
  }
});

test("compiled draws reject destroyed composed and ordinary geometry before binding buffers", async () => {
  const gpu = await init();
  try {
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array([-1, -1, 1, -1, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }] });
    const collection = instances({ capacity: 1, attributes: { tint: "float32x3", kind: "uint32" } });
    collection.add({ tint: [1, 1, 1], kind: 1 });
    const bridge = instanceGeometry(gpu, collection, { mesh });
    const output = target(gpu, { size: [1, 1] });
    const drawable = draw(gpu, { shader: prepareShader(SHADER), geometry: bridge.geometry });
    drawable.compileSync(output);

    bridge.destroy();
    expect(errorOf(() => drawable.draw(output))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });

    const slicedCollection = instances({ capacity: 1, attributes: { tint: "float32x3", kind: "uint32" } });
    slicedCollection.add({ tint: [1, 1, 1], kind: 1 });
    const slicedBridge = instanceGeometry(gpu, slicedCollection, { mesh });
    const slicedDraw = draw(gpu, { shader: prepareShader(SHADER), geometry: slicedBridge.geometry.slice({ vertexCount: 3 }) });
    slicedDraw.compileSync(output);
    slicedBridge.destroy();
    expect(errorOf(() => slicedDraw.draw(output))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });

    const ordinary = geometry(gpu, { buffers: [{ data: new Float32Array([-1, -1, 1, -1, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }] });
    const ordinaryDraw = draw(gpu, { shader: prepareShader(`@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); } @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`), geometry: ordinary.slice({ vertexCount: 3 }) });
    ordinaryDraw.compileSync(output);
    ordinary.destroy();
    expect(errorOf(() => ordinaryDraw.draw(output))).toMatchObject({ code: "VGPU-MESH-LAYOUT-INVALID" });
  } finally {
    gpu.dispose();
  }
});

test("creation preflights provenance, existing streams, collisions, and device limits before allocation", async () => {
  const gpu = await init();
  const foreign = await init();
  try {
    const collection = instances({ capacity: 1, attributes: { tint: "float32x3" } });
    const bufferCount = () => getMockGPUDeviceInstrumentation(gpu.gpu).calls.createBuffer;
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { position: "float32x2" } }] });
    let before = bufferCount();
    expect(errorOf(() => instanceGeometry(gpu, collection, { mesh: {} as never }))).toMatchObject({ code: "VGPU-INSTANCE-LAYOUT" });
    expect(bufferCount()).toBe(before);
    expect(errorOf(() => instanceGeometry(gpu, collection, { mesh: mesh.slice() as never }))).toMatchObject({
      code: "VGPU-INSTANCE-LAYOUT",
      fix: expect.stringContaining("slice.geometry"),
    });
    expect(bufferCount()).toBe(before);
    expect(errorOf(() => instanceGeometry(foreign, collection, { mesh }))).toMatchObject({ code: "VGPU-INSTANCE-LAYOUT" });
    expect(bufferCount()).toBe(before);

    const instanced = geometry(gpu, { buffers: [{ stepMode: "instance", data: new Float32Array(4), attributes: { prior: "float32x4" } }] });
    before = bufferCount();
    expect(errorOf(() => instanceGeometry(gpu, collection, { mesh: instanced }))).toMatchObject({ code: "VGPU-INSTANCE-LAYOUT" });
    expect(bufferCount()).toBe(before);

    const colliding = geometry(gpu, { buffers: [{ data: new Float32Array(4), attributes: { world0: "float32x4" } }] });
    before = bufferCount();
    expect(errorOf(() => instanceGeometry(gpu, collection, { mesh: colliding }))).toMatchObject({ code: "VGPU-INSTANCE-LAYOUT", message: expect.stringContaining("world0") });
    expect(bufferCount()).toBe(before);

    Object.defineProperty(gpu.gpu, "limits", { value: { ...gpu.gpu.limits, maxVertexAttributes: 5 }, configurable: true });
    before = bufferCount();
    expect(errorOf(() => instanceGeometry(gpu, collection, { mesh }))).toMatchObject({ code: "VGPU-INSTANCE-LAYOUT", message: expect.stringContaining("6 vertex attributes") });
    expect(bufferCount()).toBe(before);
  } finally {
    gpu.dispose();
    foreign.dispose();
  }
});

test("creation reports buffer-count, stride, and allocation limits before adding a GPU resource", async () => {
  const gpu = await init();
  try {
    const instrumentation = getMockGPUDeviceInstrumentation(gpu.gpu);
    const baseBuffers = Array.from({ length: 8 }, (_, index) => ({
      data: new Float32Array([index]),
      attributes: { [`a${index}`]: "float32" as const },
    }));
    const wideBase = geometry(gpu, { buffers: baseBuffers });
    const empty = instances({ capacity: 0 });
    let before = instrumentation.calls.createBuffer;
    expect(errorOf(() => instanceGeometry(gpu, empty, { mesh: wideBase }))).toMatchObject({
      code: "VGPU-INSTANCE-LAYOUT",
      message: expect.stringContaining("9 vertex buffers"),
    });
    expect(instrumentation.calls.createBuffer).toBe(before);

    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(2), attributes: { position: "float32x2" } }] });
    Object.defineProperty(gpu.gpu, "limits", { value: { ...gpu.gpu.limits, maxVertexAttributes: 32, maxVertexBufferArrayStride: 64 }, configurable: true });
    const wide = instances({ capacity: 0, attributes: { extra: "float32" } });
    before = instrumentation.calls.createBuffer;
    expect(errorOf(() => instanceGeometry(gpu, wide, { mesh }))).toMatchObject({
      code: "VGPU-INSTANCE-LAYOUT",
      message: expect.stringContaining("stride 68"),
    });
    expect(instrumentation.calls.createBuffer).toBe(before);

    Object.defineProperty(gpu.gpu, "limits", { value: { ...gpu.gpu.limits, maxVertexBufferArrayStride: 2048, maxBufferSize: 64 }, configurable: true });
    const tooLarge = instances({ capacity: 2 });
    before = instrumentation.calls.createBuffer;
    expect(errorOf(() => instanceGeometry(gpu, tooLarge, { mesh }))).toMatchObject({
      code: "VGPU-INSTANCE-LAYOUT",
      message: expect.stringContaining("128"),
    });
    expect(instrumentation.calls.createBuffer).toBe(before);
  } finally {
    gpu.dispose();
  }
});

test("creation wraps host mirror allocation failure without allocating a GPU resource", async () => {
  const gpu = await init();
  try {
    const instrumentation = getMockGPUDeviceInstrumentation(gpu.gpu);
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { position: "float32x2" } }] });
    const collection = instances({ capacity: 1 });
    const before = instrumentation.calls.createBuffer;
    const NativeUint8Array = globalThis.Uint8Array;
    let rejected = false;
    vi.stubGlobal("Uint8Array", new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        if (!rejected && args[0] === 64) {
          rejected = true;
          throw new RangeError("host mirror unavailable");
        }
        return Reflect.construct(target, args, newTarget);
      },
    }));
    try {
      const error = errorOf(() => instanceGeometry(gpu, collection, { mesh }));
      expect(error).toMatchObject({
        code: "VGPU-INSTANCE-LAYOUT",
        message: expect.stringContaining("64 bytes"),
      });
      expect(error.cause).toBeInstanceOf(RangeError);
      expect(instrumentation.calls.createBuffer).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  } finally {
    gpu.dispose();
  }
});

test("zero capacity allocates a legal physical buffer and publication mirrors stay independent", async () => {
  const gpu = await init();
  try {
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { position: { format: "float32x2", location: 0 } } }] });
    const empty = instances({ capacity: 0 });
    const emptyBridge = instanceGeometry(gpu, empty, { mesh });
    expect(getMockGPUDeviceInstrumentation(gpu.gpu).createBufferDescriptors.at(-1)?.size).toBe(4);
    const write = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    write.mockClear();
    expect(emptyBridge.publish()).toBe(0);
    expect(write).not.toHaveBeenCalled();

    const collection = instances({ capacity: 3, attributes: { tint: "float32x3", kind: "uint32" } });
    const first = collection.add({ tint: [1, 0, 0], kind: 1 });
    const second = collection.add({ tint: [0, 1, 0], kind: 2 });
    const a = instanceGeometry(gpu, collection, { mesh });
    const b = instanceGeometry(gpu, collection, { mesh });
    write.mockClear();
    expect(a.publish()).toBe(2);
    expect(b.publish()).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);

    collection.setWorld(first, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, 0, 0, 1]);
    collection.set(second, { kind: 3 });
    expect(a.publish()).toBe(2);
    expect(write).toHaveBeenCalledTimes(3);
    expect(b.publish()).toBe(2);
    expect(write).toHaveBeenCalledTimes(4);

    collection.remove(second);
    expect(a.publish()).toBe(1);
    expect(write).toHaveBeenCalledTimes(4);
    expect(b.publish()).toBe(1);
    expect(write).toHaveBeenCalledTimes(4);
  } finally {
    gpu.dispose();
  }
});

test("failed publication preserves its cursor, never consults sources, and rejects sync reentrancy", async () => {
  const gpu = await init();
  try {
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { position: { format: "float32x2", location: 0 } } }] });
    const collection = instances({ capacity: 1 });
    const id = collection.add();
    const a = instanceGeometry(gpu, collection, { mesh });
    const b = instanceGeometry(gpu, collection, { mesh });
    const write = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    write.mockImplementationOnce(() => { throw new Error("upload failed"); });
    expect(() => a.publish()).toThrow("upload failed");
    expect(b.publish()).toBe(1);
    expect(a.publish()).toBe(1);
    expect(write).toHaveBeenCalledTimes(3);

    let sourceCalls = 0;
    collection.bindWorld(id, () => {
      sourceCalls += 1;
      a.publish();
      return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    });
    expect(a.publish()).toBe(1);
    expect(sourceCalls).toBe(0);
    expect(errorOf(() => collection.syncWorlds())).toMatchObject({ code: "VGPU-INSTANCE-REENTRANT" });
  } finally {
    gpu.dispose();
  }
});

test("base, wrapper, gpu, direct, indirect, and bundle paths share actionable lifetime guards", async () => {
  const make = async (indexed = false) => {
    const gpu = await init();
    const mesh = geometry(gpu, {
      buffers: [{ data: new Float32Array([-1, -1, 1, -1, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }],
      ...(indexed ? { indices: new Uint16Array([0, 1, 2]) } : {}),
    });
    const collection = instances({ capacity: 1, attributes: { tint: "float32x3", kind: "uint32" } });
    collection.add({ tint: [1, 1, 1], kind: 1 });
    const bridge = instanceGeometry(gpu, collection, { mesh });
    const output = target(gpu, { size: [1, 1] });
    const drawable = draw(gpu, { shader: prepareShader(SHADER), geometry: bridge.geometry });
    drawable.compileSync(output);
    return { gpu, mesh, bridge, output, drawable };
  };

  const direct = await make();
  const directInstanceStream = direct.bridge.geometry.buffers.at(-1)!;
  direct.mesh.destroy();
  expect(() => directInstanceStream.write(new Uint8Array(80))).not.toThrow();
  expect(errorOf(() => direct.drawable.draw({ target: direct.output, instances: 0 }))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
  expect(errorOf(() => bundle(direct.gpu, { target: direct.output }, (recorder) => recorder.draw(direct.drawable, { instances: 0 })))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
  expect(errorOf(() => direct.bridge.publish())).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
  direct.bridge.destroy();
  expect(() => direct.bridge.destroy()).not.toThrow();
  expect(() => directInstanceStream.write(new Uint8Array(80))).toThrowError(/destroyed/i);
  direct.gpu.dispose();

  const indexed = await make(true);
  const indirect = storage(indexed.gpu, 20, { indirect: true });
  const indexedInstanceStream = indexed.bridge.geometry.buffers.at(-1)!;
  indexed.bridge.geometry.destroy();
  expect(() => indexed.bridge.destroy()).not.toThrow();
  expect(() => indexedInstanceStream.write(new Uint8Array(80))).toThrowError(/destroyed/i);
  expect(errorOf(() => indexed.drawable.draw({ target: indexed.output, instances: 1 }))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
  expect(errorOf(() => indexed.drawable.draw({ target: indexed.output, indirect }))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
  expect(() => indexed.mesh.write(new Float32Array([-1, -1, 1, -1, 0, 1]))).not.toThrow();
  indexed.gpu.dispose();

  const recorded = await make();
  const frozen = bundle(recorded.gpu, { target: recorded.output, label: "instances" }, (recorder) => recorder.draw(recorded.drawable, { instances: 1 }));
  recorded.bridge.destroy();
  expect(errorOf(() => frame(recorded.gpu, (current) => current.pass({ target: recorded.output }, (pass) => pass.bundles(frozen))))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
  recorded.gpu.dispose();

  const disposed = await make();
  const disposedInstanceStream = disposed.bridge.geometry.buffers.at(-1)!;
  disposed.gpu.dispose();
  expect(errorOf(() => disposed.bridge.publish())).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
  expect(() => disposed.bridge.destroy()).not.toThrow();
  expect(() => disposedInstanceStream.write(new Uint8Array(80))).toThrowError(/destroyed/i);
  expect(() => disposed.mesh.write(new Float32Array([-1, -1, 1, -1, 0, 1]))).toThrowError(/destroyed/i);
});
