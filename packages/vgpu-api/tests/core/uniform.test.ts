import { expect, test, vi } from "vitest";
import { createMockGPUDevice, Device, getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { Uniform } from "../../src/core.ts";

const uniformUsage = 64;
const copyDstUsage = 8;

function makeDevice(): Device {
  return new Device(createMockGPUDevice(), null);
}

test("creates a uniform+copy_dst buffer sized to the request", () => {
  const device = makeDevice();
  const uniform = new Uniform(device, { size: 64, label: "globals" });

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.createBufferDescriptors[0]).toMatchObject({ size: 64, usage: uniformUsage | copyDstUsage });
  expect(uniform.size).toBe(64);
  expect(uniform.gpu).toBe(uniform.buffer.gpu);
  device.destroy();
});

test("creates a single bind group bound to binding 0 of the buffer", () => {
  const device = makeDevice();
  const uniform = new Uniform(device, { size: 32 });

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createBindGroup).toBe(1);
  const [bindGroup] = mock.createBindGroupDescriptors;
  expect(bindGroup.layout).toBe(uniform.bindGroupLayout);
  expect([...bindGroup.entries]).toEqual([{ binding: 0, resource: { buffer: uniform.gpu } }]);
  expect(uniform.bindGroup).not.toBeNull();
  device.destroy();
});

test("write uploads via queue.writeBuffer with no dynamic offset", () => {
  const device = makeDevice();
  const uniform = new Uniform(device, { size: 16 });
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");
  const data = new Float32Array([1, 2, 3, 4]);

  uniform.write(data);

  expect(writeBuffer).toHaveBeenCalledWith(uniform.gpu, 0, data);
  device.destroy();
});

test("write forwards an explicit byte offset", () => {
  const device = makeDevice();
  const uniform = new Uniform(device, { size: 32 });
  const writeBuffer = vi.spyOn(device.gpu.queue, "writeBuffer");
  const data = new Float32Array([9]);

  uniform.write(data, 16);

  expect(writeBuffer).toHaveBeenCalledWith(uniform.gpu, 16, data);
  device.destroy();
});

test("reuses a provided bind group layout instead of creating one", () => {
  const device = makeDevice();
  const createBindGroupLayout = vi.spyOn(device.gpu, "createBindGroupLayout");
  const bindGroupLayout = {} as GPUBindGroupLayout;

  const uniform = new Uniform(device, { size: 16, bindGroupLayout });

  expect(uniform.bindGroupLayout).toBe(bindGroupLayout);
  expect(createBindGroupLayout).not.toHaveBeenCalled();
  device.destroy();
});

test("destroy releases the buffer once and is idempotent", () => {
  const device = makeDevice();
  const uniform = new Uniform(device, { size: 16 });
  const destroy = vi.spyOn(uniform.buffer, "destroy");

  uniform.destroy();
  uniform.destroy();

  expect(destroy).toHaveBeenCalledTimes(1);
  device.destroy();
});
