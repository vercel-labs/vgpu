import { expect, test, vi } from "vitest";
import { Device } from "../src/device.ts";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => { resolve = r; }), resolve };
}

function fakeDevice() {
  const lost = deferred<GPUDeviceLostInfo>();
  const destroy = vi.fn();
  const writeBuffer = vi.fn();
  const rawBuffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
  const gpu = {
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined, writeBuffer },
    limits: {}, features: new Set(), lost: lost.promise,
    createBuffer(desc: GPUBufferDescriptor) {
      const buffer = { size: Number(desc.size), usage: desc.usage, label: desc.label ?? "", destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
      rawBuffers.push(buffer); return buffer;
    },
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    createTexture: () => ({ destroy() {}, createView: () => ({}) }),
    createShaderModule: () => ({}), destroy,
  } as unknown as GPUDevice;
  return { gpu, lost, destroy, writeBuffer, rawBuffers };
}

function rawBuffer(usage = 128 | 4 | 8, size = 16) {
  return { size, usage, label: "ort-output", destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
}

test("owned and external devices have distinct idempotent native ownership", () => {
  const owned = fakeDevice(); const external = fakeDevice();
  new Device(owned.gpu).dispose();
  const borrowed = new Device(external.gpu, null, "external"); borrowed.dispose(); borrowed.dispose();
  expect(owned.destroy).toHaveBeenCalledOnce();
  expect(external.destroy).not.toHaveBeenCalled();
});

test("disposing a device does not cascade to buffers", () => {
  const f = fakeDevice(); const device = new Device(f.gpu);
  const child = device.createBuffer({ size: 4, usage: ["copy_dst"] });
  device.dispose();
  expect(f.rawBuffers[0]!.destroy).not.toHaveBeenCalled();
  child.dispose();
  expect(f.rawBuffers[0]!.destroy).toHaveBeenCalledOnce();
});

test("device loss preserves reason and message and invalidates public operations", async () => {
  const f = fakeDevice(); const device = new Device(f.gpu, null, "external");
  f.lost.resolve({ reason: "destroyed", message: "ORT released the device" } as GPUDeviceLostInfo);
  await Promise.resolve();
  expect(() => device.createBuffer({ size: 4, usage: ["copy_dst"] })).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST", message: expect.stringContaining("ORT released the device") }));
  device.dispose();
  expect(f.destroy).not.toHaveBeenCalled();
});

test("wrapBuffer preserves identity, metadata, signal semantics, and never native-destroys", () => {
  const f = fakeDevice(); const device = new Device(f.gpu, null, "external"); const raw = rawBuffer();
  const wrapped = device.wrapBuffer(raw); const sibling = device.wrapBuffer(raw); const calls = vi.fn();
  wrapped.onDestroy(calls); wrapped.dispose(); wrapped.dispose(); wrapped.onDestroy(calls);
  sibling.write(new Uint32Array([1]));
  expect(wrapped.gpu).toBe(raw);
  expect(wrapped.options).toMatchObject({ size: 16, usage: expect.arrayContaining(["storage", "copy_src", "copy_dst"]) });
  expect(calls).toHaveBeenCalledTimes(2); // one original listener and one late listener
  expect(raw.destroy).not.toHaveBeenCalled();
  expect(() => wrapped.write(new Uint32Array([1]))).toThrow(expect.objectContaining({ code: "VGPU-BUFFER-DISPOSED" }));
  sibling.dispose();
  expect(raw.destroy).not.toHaveBeenCalled();
  device.dispose();
});

test("external buffer validates usage, alignment, and range", async () => {
  const f = fakeDevice(); const device = new Device(f.gpu, null, "external");
  const wrapped = device.wrapBuffer(rawBuffer(128, 16));
  expect(() => wrapped.write(new Uint32Array([1]))).toThrow(expect.objectContaining({ code: "VGPU-EXTERNAL-BUFFER-VALIDATION" }));
  await expect(wrapped.read(4)).rejects.toMatchObject({ code: "VGPU-EXTERNAL-BUFFER-VALIDATION" });
  const copyable = device.wrapBuffer(rawBuffer(4 | 8, 16));
  const nativeCause = new Error("native validation failure");
  f.writeBuffer.mockImplementationOnce(() => { throw nativeCause; });
  expect(() => copyable.write(new Uint32Array([1]))).toThrow(expect.objectContaining({ code: "VGPU-EXTERNAL-BUFFER-VALIDATION", cause: nativeCause }));
  expect(() => copyable.write(new Uint32Array([1]), 2)).toThrow(expect.objectContaining({ code: "VGPU-EXTERNAL-BUFFER-VALIDATION" }));
  await expect(copyable.read(20)).rejects.toMatchObject({ code: "VGPU-EXTERNAL-BUFFER-VALIDATION" });
  device.dispose();
});

test("retained texture operations reject after device disposal", () => {
  const f = fakeDevice();
  const device = new Device(f.gpu, null, "external");
  const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: ["texture_binding"] });
  device.dispose();
  expect(() => texture.createView()).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  expect(() => texture.resize([2, 2])).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  expect(f.destroy).not.toHaveBeenCalled();
});

test("wrapBuffer rejects non-observable buffer shapes", () => {
  const f = fakeDevice(); const device = new Device(f.gpu, null, "external");
  expect(() => device.wrapBuffer({ size: -1, usage: 4, destroy() {} } as unknown as GPUBuffer)).toThrow(expect.objectContaining({ code: "VGPU-EXTERNAL-BUFFER-INVALID" }));
  device.dispose();
});
