import { expect, test, vi } from "vitest";
import { createMockGPUDevice, Device, getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { StorageBuffer } from "@vgpu/render";

const storageUsage = 128;
const copyDstUsage = 8;
// GPUShaderStage globals are absent under the mock device, so visibility falls back to
// the helper's literals: VERTEX=1, FRAGMENT=2, COMPUTE=4.
const vertexFlag = 1;
const fragmentFlag = 2;
const computeFlag = 4;

function makeDevice(): Device {
  return new Device(createMockGPUDevice(), null);
}

test("creates a storage+copy_dst buffer sized to the request", () => {
  const device = makeDevice();
  const storage = new StorageBuffer(device, { size: 256, label: "values" });

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.createBufferDescriptors[0]).toMatchObject({ size: 256, usage: storageUsage | copyDstUsage });
  expect(storage.size).toBe(256);
  expect(storage.gpu).toBe(storage.buffer.gpu);
  device.destroy();
});

test("creates a single bind group bound to binding 0 of the buffer", () => {
  const device = makeDevice();
  const storage = new StorageBuffer(device, { size: 64 });

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createBindGroup).toBe(1);
  const [bindGroup] = mock.createBindGroupDescriptors;
  expect(bindGroup.layout).toBe(storage.bindGroupLayout);
  expect([...bindGroup.entries]).toEqual([{ binding: 0, resource: { buffer: storage.gpu } }]);
  expect(storage.bindGroup).not.toBeNull();
  device.destroy();
});

test("read access builds a read-only-storage layout entry at binding 0", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");

  new StorageBuffer(device, { size: 64 });

  expect(createBindGroupLayout).toHaveBeenCalledTimes(1);
  const [{ entries }] = createBindGroupLayout.mock.calls[0];
  expect([...entries]).toEqual([
    expect.objectContaining({ binding: 0, buffer: { type: "read-only-storage", minBindingSize: 64 } }),
  ]);
  device.destroy();
});

test("read-write access builds a storage layout entry at binding 0", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");

  const storage = new StorageBuffer(device, { size: 64, access: "read-write" });

  expect(storage.access).toBe("read-write");
  const [{ entries }] = createBindGroupLayout.mock.calls[0];
  expect([...entries]).toEqual([
    expect.objectContaining({ binding: 0, buffer: { type: "storage", minBindingSize: 64 } }),
  ]);
  device.destroy();
});

test("read-write default visibility excludes the vertex stage", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");

  new StorageBuffer(device, { size: 64, access: "read-write" });

  const [{ entries }] = createBindGroupLayout.mock.calls[0];
  const [entry] = [...entries];
  expect(entry.visibility & vertexFlag).toBe(0);
  device.destroy();
});

test("read default visibility is FRAGMENT | COMPUTE and excludes the vertex stage", () => {
  // Read-only storage IS legal in the vertex stage, but maxStorageBuffersInVertexStage is 0 on
  // many adapters (software/CI Vulkan), so the default must not request VERTEX — that would
  // silently invalidate the layout there. Vertex-stage storage is opt-in via explicit visibility.
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");

  new StorageBuffer(device, { size: 64 });

  const [{ entries }] = createBindGroupLayout.mock.calls[0];
  const [entry] = [...entries];
  expect(entry.visibility & vertexFlag).toBe(0);
  expect(entry.visibility).toBe(fragmentFlag | computeFlag);
  device.destroy();
});

test("explicit visibility overrides the read default (vertex-stage opt-in)", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");

  new StorageBuffer(device, { size: 64, visibility: vertexFlag | fragmentFlag });

  const [{ entries }] = createBindGroupLayout.mock.calls[0];
  const [entry] = [...entries];
  expect(entry.visibility).toBe(vertexFlag | fragmentFlag);
  device.destroy();
});

test("write uploads via queue.writeBuffer with no dynamic offset", () => {
  const device = makeDevice();
  const storage = new StorageBuffer(device, { size: 16 });
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");
  const data = new Float32Array([1, 2, 3, 4]);

  storage.write(data);

  expect(writeBuffer).toHaveBeenCalledWith(storage.gpu, 0, data);
  device.destroy();
});

test("write forwards an explicit byte offset", () => {
  const device = makeDevice();
  const storage = new StorageBuffer(device, { size: 32 });
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");
  const data = new Float32Array([9]);

  storage.write(data, 16);

  expect(writeBuffer).toHaveBeenCalledWith(storage.gpu, 16, data);
  device.destroy();
});

test("reuses a provided bind group layout instead of creating one", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");
  const bindGroupLayout = {} as GPUBindGroupLayout;

  const storage = new StorageBuffer(device, { size: 16, bindGroupLayout });

  expect(storage.bindGroupLayout).toBe(bindGroupLayout);
  expect(createBindGroupLayout).not.toHaveBeenCalled();
  device.destroy();
});

test("destroy releases the buffer once and is idempotent", () => {
  const device = makeDevice();
  const storage = new StorageBuffer(device, { size: 16 });
  const destroy = vi.spyOn(storage.buffer, "destroy");

  storage.destroy();
  storage.destroy();

  expect(destroy).toHaveBeenCalledTimes(1);
  device.destroy();
});
