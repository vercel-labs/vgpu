import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";
import { renderTarget, renderTargetMulti } from "@vgpu/render/passes";

async function device() {
  return (await App.create({ adapter: createMockAdapter() })).device;
}

test("renderTargetMulti creates 2-attachment MRT", async () => {
  const d = await device();
  const target = await renderTargetMulti({ device: d, size: [8, 4], colors: [{ format: "rgba8unorm" }, { format: "rgba16float" }] });
  expect(target.colors).toHaveLength(2);
  expect(target.gpu.colorAttachments).toHaveLength(2);
  expect(target.format).toBe("rgba8unorm");
  expect(target.colors[1]?.format).toBe("rgba16float");
  d.destroy();
});

test("renderTargetMulti creates 3-attachment MRT", async () => {
  const d = await device();
  const target = await renderTargetMulti({ device: d, size: [8, 4], colors: [
    { format: "rgba8unorm" }, { format: "rg32float" }, { format: "rgba16float" },
  ] });
  expect(target.colors).toHaveLength(3);
  expect(target.gpu.colorAttachments).toHaveLength(3);
  d.destroy();
});

test("renderTargetMulti propagates per-attachment labels and clearColor", async () => {
  const d = await device();
  const target = await renderTargetMulti({ device: d, size: [8, 4], colors: [
    { format: "rgba8unorm", label: "albedo", clearColor: [1, 0, 0, 1] },
    { format: "rgba8unorm", label: "normal", clearColor: { r: 0, g: 1, b: 0, a: 1 } },
  ] });
  expect(target.colors[0]?.label).toBe("albedo");
  expect(target.colors[1]?.label).toBe("normal");
  expect(target.gpu.colorAttachments[0]?.clearValue).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  expect(target.gpu.colorAttachments[1]?.clearValue).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  d.destroy();
});

test("renderTargetMulti rejects unsupported shapes", async () => {
  const d = await device();
  await expect(renderTargetMulti({ device: d, size: [8, 4], colors: [{ format: "rgba8unorm" }], msaa: true } as never))
    .rejects.toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
  await expect(renderTargetMulti({ device: d, size: [8, 4], colors: [] }))
    .rejects.toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
  await expect(renderTargetMulti({ device: d, size: [8, 4], colors: [{ format: "depth24plus" as GPUTextureFormat }] }))
    .rejects.toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
  d.destroy();
});

test("renderTarget overload accepts colors and preserves length-1 aliases", async () => {
  const d = await device();
  const viaMulti = await renderTarget({ device: d, size: [8, 4], colors: [{ format: "rgba8unorm" }] });
  const legacy = await renderTarget({ device: d, size: [8, 4], format: "rgba8unorm" });
  expect(viaMulti.colors).toHaveLength(1);
  expect(viaMulti.color.format).toBe(legacy.color.format);
  expect(viaMulti.format).toBe(legacy.format);
  expect(viaMulti.sampleCount).toBe(legacy.sampleCount);
  expect(viaMulti.gpu.colorAttachment).toBe(viaMulti.gpu.colorAttachments[0]);
  d.destroy();
});
