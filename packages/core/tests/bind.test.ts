import { expect, test } from "vitest";
import { Buffer } from "../src/buffer.ts";
import {
  bind,
  createBindGroup,
  createBindGroupLayout,
  createPipelineLayout,
  createSampler,
} from "../src/bind.ts";
import { Device } from "../src/device.ts";
import { ValidationError } from "../src/errors.ts";
import { Texture } from "../src/texture.ts";

function createCaptureDevice() {
  const calls: Record<string, unknown> = {};
  const gpu = {
    createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor) {
      calls.bindGroupLayout = desc;
      return { label: desc.label } as GPUBindGroupLayout;
    },
    createPipelineLayout(desc: GPUPipelineLayoutDescriptor) {
      calls.pipelineLayout = desc;
      return { label: desc.label } as GPUPipelineLayout;
    },
    createBindGroup(desc: GPUBindGroupDescriptor) {
      calls.bindGroup = desc;
      return { label: desc.label } as GPUBindGroup;
    },
    createSampler(desc: GPUSamplerDescriptor) {
      calls.sampler = desc;
      return { label: desc.label } as GPUSampler;
    },
  } as GPUDevice;
  return { gpu, calls };
}

test("creates explicit bind group layout descriptors", () => {
  const { gpu, calls } = createCaptureDevice();

  const layout = createBindGroupLayout(gpu, {
    label: "scene.bindings",
    entries: [
      bind.uniform(0, "vertex|fragment"),
      bind.texture(1, "fragment", { sampleType: "float" }),
      bind.sampler(2, "fragment", { type: "filtering" }),
    ],
  });

  expect(layout).toEqual({ label: "scene.bindings" });
  expect(calls.bindGroupLayout).toEqual({
    label: "scene.bindings",
    entries: [
      { binding: 0, visibility: 3, buffer: { type: "uniform" } },
      { binding: 1, visibility: 2, texture: { sampleType: "float" } },
      { binding: 2, visibility: 2, sampler: { type: "filtering" } },
    ],
  });
});

test("creates explicit pipeline layout and sampler descriptors", () => {
  const { gpu, calls } = createCaptureDevice();
  const groupLayout = {} as GPUBindGroupLayout;

  createPipelineLayout({ gpu }, { label: "pipeline", bindGroups: [groupLayout] });
  createSampler(gpu, { label: "linear", magFilter: "linear", minFilter: "linear" });

  expect(calls.pipelineLayout).toEqual({ label: "pipeline", bindGroupLayouts: [groupLayout] });
  expect(calls.sampler).toEqual({ label: "linear", magFilter: "linear", minFilter: "linear" });
});

test("creates bind groups only when an explicit layout is provided", () => {
  const { gpu, calls } = createCaptureDevice();
  const layout = {} as GPUBindGroupLayout;
  const rawResource = { textureViewBrand: true } as unknown as GPUTextureView;

  createBindGroup(gpu, { label: "scene", layout, entries: [bind.resource(0, rawResource)] });

  expect(calls.bindGroup).toEqual({ label: "scene", layout, entries: [{ binding: 0, resource: rawResource }] });
  expect(() => createBindGroup(gpu, { label: "bad", layout: undefined as unknown as GPUBindGroupLayout, entries: [] })).toThrow(ValidationError);
});

test("unwraps vgpu and raw binding resources", () => {
  const rawBuffer = { size: 16, usage: 64, destroy() {} } as unknown as GPUBuffer;
  const vgpuBuffer = new Buffer({} as Device, rawBuffer, { size: 16, usage: ["uniform"] });
  const view = { view: true } as unknown as GPUTextureView;
  const rawTexture = { createView: () => view, destroy() {} } as unknown as GPUTexture;
  const vgpuTexture = new Texture({} as Device, rawTexture, { size: [1, 1], format: "rgba8unorm", usage: ["texture_binding"] });
  const rawBinding = { buffer: rawBuffer, offset: 4 } as GPUBufferBinding;
  const sampler = { sampler: true } as unknown as GPUSampler;

  expect(bind.resource(0, vgpuBuffer).resource).toEqual({ buffer: rawBuffer });
  expect(bind.resource(1, rawBuffer).resource).toEqual({ buffer: rawBuffer });
  expect(bind.resource(2, vgpuTexture).resource).toBe(view);
  expect(bind.resource(3, view).resource).toBe(view);
  expect(bind.resource(4, sampler).resource).toBe(sampler);
  expect(bind.resource(5, rawBinding).resource).toBe(rawBinding);
});

test("parses shader stage visibility in headless runtimes", () => {
  expect(bind.uniform(0, "vertex|fragment").visibility).toBe(3);
  expect(bind.uniform(1, "compute").visibility).toBe(4);
  expect(bind.uniform(2, ["vertex", "compute"]).visibility).toBe(5);
  expect(bind.uniform(3, 1 | 2).visibility).toBe(3);
});

test("creates storage binding descriptors", () => {
  expect(bind.storage(0, "compute")).toEqual({
    binding: 0,
    visibility: 4,
    buffer: { type: "storage" },
  });
  expect(bind.readonlyStorage(1, "fragment")).toEqual({
    binding: 1,
    visibility: 2,
    buffer: { type: "read-only-storage" },
  });
});

test("creates storage texture binding descriptors", () => {
  expect(bind.storageTexture(2, "compute", { access: "write-only", format: "rgba8unorm" })).toEqual({
    binding: 2,
    visibility: 4,
    storageTexture: { access: "write-only", format: "rgba8unorm" },
  });
});

test("requires explicit numeric bindings", () => {
  expect(() => bind.uniform(-1, "vertex")).toThrow(ValidationError);
  expect(() => bind.resource(1.5, {})).toThrow(ValidationError);
});
