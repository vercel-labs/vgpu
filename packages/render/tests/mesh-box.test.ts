import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, Buffer } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import { expect, test } from "vitest";

test("Mesh.box returns a 36-vertex mesh with correct bbox", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const unit = Mesh.box({ device });
  expect(unit.vertexCount).toBe(36);
  expect(Array.from(unit.bbox.min)).toEqual([-0.5, -0.5, -0.5]);
  expect(Array.from(unit.bbox.max)).toEqual([0.5, 0.5, 0.5]);
  expect(unit.attributes).toEqual({
    stride: 24,
    position: { offset: 0, format: "float32x3" },
    normal: { offset: 12, format: "float32x3" },
  });
  expect(unit.vertexBuffer).toBeInstanceOf(Buffer);
  expect(unit.layout).toBe("position-normal");
  expect(unit.gpu).toEqual({ vertexBuffer: unit.vertexBuffer.gpu });

  const sized = Mesh.box({ device, size: 2 });
  expect(Array.from(sized.bbox.min)).toEqual([-1, -1, -1]);
  expect(Array.from(sized.bbox.max)).toEqual([1, 1, 1]);

  device.destroy();
});

test("Mesh.box caches per-device per-size", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const a = Mesh.box({ device, size: 1 });
  const b = Mesh.box({ device, size: 1 });
  expect(a).toBe(b);

  device.destroy();
});

test("Mesh.box with different size returns different Mesh", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const a = Mesh.box({ device, size: 1 });
  const c = Mesh.box({ device, size: 2 });
  expect(a).not.toBe(c);
  expect(a.bbox.max[0]).toBe(0.5);
  expect(c.bbox.max[0]).toBe(1);

  device.destroy();
});

test("Mesh.box with different devices returns different Mesh", async () => {
  const first = await App.create({ adapter: createMockAdapter() });
  const second = await App.create({ adapter: createMockAdapter() });

  const a = Mesh.box({ device: first.device, size: 1 });
  const b = Mesh.box({ device: second.device, size: 1 });
  expect(a).not.toBe(b);

  first.device.destroy();
  second.device.destroy();
});

test("Mesh.box uploads 216 floats of interleaved position and normal data", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const mesh = Mesh.box({ device });
  expect(mesh.vertexBuffer.options.size).toBe(216 * 4);

  device.destroy();
});
