import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, ValidationError } from "@vgpu/core";
import { renderTarget, renderTargetForCanvas } from "@vgpu/render/passes";

test("renderTarget creates color-only target with correct format", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const target = await renderTarget({ device, size: [8, 4], format: "rgba8unorm" });

  expect(target.color.format).toBe("rgba8unorm");
  expect(target.colors).toHaveLength(1);
  expect(target.depth).toBeUndefined();
  expect(target.sampleCount).toBe(1);
  expect(target.gpu.colorAttachment.view).toBeTruthy();
  expect(target.gpu.depthStencilAttachment).toBeUndefined();
  expect(target.gpu.resolveTexture).toBeUndefined();
  device.destroy();
});

test("renderTarget with depth: true creates depth attachment", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const target = await renderTarget({ device, size: [8, 4], depth: true });

  expect(target.depth).toBeDefined();
  expect(target.depth?.format).toBe("depth24plus");
  expect(target.gpu.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 });
  expect(target.gpu.depthStencilAttachment?.view).toBeTruthy();
  device.destroy();
});

test("renderTarget with msaa: true creates multisample color + resolve sibling", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const target = await renderTarget({ device, size: [8, 4], msaa: true });

  expect(target.sampleCount).toBe(4);
  expect(target.gpu.colorTexture.sampleCount).toBe(4);
  expect(target.gpu.resolveTexture?.sampleCount).toBe(1);
  expect(target.gpu.colorAttachment.resolveTarget).toBeDefined();
  expect(target.color.gpu).toBe(target.gpu.resolveTexture);
  device.destroy();
});

test("renderTarget label \"scene\" propagates to attachment textures", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const plain = await renderTarget({ device, size: [8, 4], label: "scene", depth: true });
  const msaa = await renderTarget({ device, size: [8, 4], label: "scene", msaa: true });

  expect(plain.color.label).toBe("scene.color");
  expect(plain.depth?.label).toBe("scene.depth");
  expect(msaa.color.label).toBe("scene.color.resolve");
  device.destroy();
});


test("renderTarget-owned color and depth textures cannot be resized", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const target = await renderTarget({ device, size: [8, 4], depth: true });

  expect(() => target.color.resize([16, 8])).toThrowError(ValidationError);
  expect(() => target.color.resize([16, 8])).toThrow("captured by a renderTarget() snapshot");
  expect(() => target.colors[0].resize([16, 8])).toThrow("captured by a renderTarget() snapshot");
  expect(() => target.depth?.resize([16, 8])).toThrow("captured by a renderTarget() snapshot");
  device.destroy();
});

test("renderTarget-owned MSAA resolve texture cannot be resized", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const target = await renderTarget({ device, size: [8, 4], msaa: true });

  expect(target.color.gpu).toBe(target.gpu.resolveTexture);
  expect(() => target.color.resize([16, 8])).toThrowError(ValidationError);
  expect(() => target.color.resize([16, 8])).toThrow("captured by a renderTarget() snapshot");
  device.destroy();
});

test("renderTargetForCanvas .color resolves to current texture view per access", () => {
  const first = gpuTexture("first");
  const second = gpuTexture("second");
  const context = canvasContext([first, second, first, second]);
  const target = renderTargetForCanvas(context, { label: "screen" });

  const colorA = target.color;
  const colorB = target.color;
  const gpuA = target.gpu;
  const gpuB = target.gpu;

  expect(colorA.gpu).toBe(first);
  expect(colorB.gpu).toBe(second);
  expect(colorA.gpu).not.toBe(colorB.gpu);
  expect(gpuA.colorAttachment.view).toMatchObject({ label: "first.view" });
  expect(gpuB.colorAttachment.view).toMatchObject({ label: "second.view" });
});

test("renderTargetForCanvas .color texture cannot be resized", () => {
  const target = renderTargetForCanvas(canvasContext([gpuTexture("canvas")]), { label: "screen" });

  expect(() => target.color.resize([32, 18])).toThrowError(ValidationError);
  expect(() => target.color.resize([32, 18])).toThrow("externally owned");
});

test("renderTargetForCanvas .color destroy does not destroy the canvas texture", () => {
  let destroyCalls = 0;
  const target = renderTargetForCanvas(canvasContext([gpuTexture("canvas", () => { destroyCalls += 1; })]), { label: "screen" });
  const color = target.color;

  expect(color.view).toMatchObject({ label: "canvas.view" });
  color.destroy();

  expect(destroyCalls).toBe(0);
  expect(() => color.view).toThrowError(ValidationError);
  expect(() => color.view).toThrow("Texture is destroyed");
  expect(() => color.resize([32, 18])).toThrow("Texture is destroyed");
});

function gpuTexture(label: string, onDestroy: () => void = () => {}): GPUTexture {
  return {
    label,
    sampleCount: 1,
    createView: () => ({ label: `${label}.view` }) as GPUTextureView,
    destroy: onDestroy,
  } as GPUTexture;
}

function canvasContext(textures: GPUTexture[]): GPUCanvasContext {
  let index = 0;
  return {
    canvas: { width: 16, height: 9 },
    getCurrentTexture: () => textures[index++],
    getConfiguration: () => ({ format: "bgra8unorm" as GPUTextureFormat }),
  } as unknown as GPUCanvasContext;
}
