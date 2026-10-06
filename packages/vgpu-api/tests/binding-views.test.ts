import { prepareShader } from "@vgpu/wgsl/prepare";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { expect, test, vi } from "vitest";
import { bindingViewCacheTestState } from "../src/binding-views.ts";
import { bindingTextureView } from "../src/binding-views.ts";
import { createBindGroupCache } from "../src/bind-cache.ts";
import { compute, effect, frame, init, target, texture } from "../src/mock.ts";

const SAMPLE = `
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }
`;

const STORAGE = `
@group(0) @binding(0) var destination: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(1) fn main() { textureStore(destination, vec2u(0), vec4f(1)); }
`;

test("binding normalization reuses the compatible default view while public createView stays fresh", async () => {
  const gpu = await init();
  try {
    const source = texture(gpu, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["texture_binding"] });
    const createView = vi.spyOn(source.gpu, "createView");
    const first = effect(gpu, prepareShader(SAMPLE));
    const second = effect(gpu, prepareShader(SAMPLE));

    first.set({ source });
    first.set({ source });
    second.set({ source });
    expect(createView).toHaveBeenCalledTimes(1);

    expect(source.createView()).not.toBe(source.createView());
    expect(createView).toHaveBeenCalledTimes(3);
  } finally {
    gpu.dispose();
  }
});

test("one-mip storage shares a proven-equivalent default view while a mip chain gets a variant", async () => {
  const gpu = await init();
  try {
    const single = texture(gpu, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["texture_binding", "storage_binding"] });
    const singleViews = vi.spyOn(single.gpu, "createView");
    compute(gpu, prepareShader(STORAGE), { set: { destination: single } });
    effect(gpu, prepareShader(SAMPLE), { set: { source: single } });
    expect(singleViews).toHaveBeenCalledTimes(1);

    const mipped = texture(gpu, { kind: "2d", size: [4, 4], mipLevelCount: 3, format: "rgba8unorm", usage: ["texture_binding", "storage_binding"] });
    const mippedViews = vi.spyOn(mipped.gpu, "createView");
    compute(gpu, prepareShader(STORAGE), { set: { destination: mipped } });
    effect(gpu, prepareShader(SAMPLE), { set: { source: mipped } });
    expect(mippedViews.mock.calls.map(([descriptor]) => descriptor)).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }),
      undefined,
    ]));
    expect(mippedViews).toHaveBeenCalledTimes(2);
  } finally {
    gpu.dispose();
  }
});

test.each([1, 3])("array storage and sampling preserve the 2d-array shape for %i layers", async (layers) => {
  const gpu = await init();
  try {
    const atlas = texture(gpu, { kind: "2d-array", size: [4, 4], layers, format: "rgba8unorm", usage: ["texture_binding", "storage_binding"] });
    const views = vi.spyOn(atlas.gpu, "createView");
    compute(gpu, prepareShader(`
      @group(0) @binding(0) var atlas: texture_storage_2d_array<rgba8unorm, write>;
      @compute @workgroup_size(1) fn main() { textureStore(atlas, vec2u(0), 0, vec4f(1)); }
    `), { set: { atlas } });
    effect(gpu, prepareShader(`
      @group(0) @binding(0) var atlas: texture_2d_array<f32>;
      @fragment fn main() -> @location(0) vec4f { return textureLoad(atlas, vec2i(0), 0, 0); }
    `), { set: { atlas } });
    expect(views).toHaveBeenCalledTimes(1);
    expect(views.mock.calls[0]![0]).toEqual(expect.objectContaining({ dimension: "2d-array" }));
  } finally {
    gpu.dispose();
  }
});

test("depth-only views remain distinct from all-aspect defaults", async () => {
  const gpu = await init();
  try {
    const depth = texture(gpu, { kind: "2d", size: [4, 4], format: "depth24plus-stencil8", usage: ["texture_binding"] });
    const views = vi.spyOn(depth.gpu, "createView");
    const all = depth.view;
    const sampled = effect(gpu, prepareShader(`
      @group(0) @binding(0) var depth: texture_depth_2d;
      @fragment fn main() -> @location(0) vec4f { return vec4f(textureLoad(depth, vec2i(0), 0)); }
    `), { set: { depth } });
    const resource = getBindingResource(sampled, gpu);
    expect(resource).not.toBe(all);
    expect(views.mock.calls).toEqual([[undefined], [{ aspect: "depth-only" }]]);
  } finally {
    gpu.dispose();
  }
});

test("generated 1d and 3d descriptors retain their dimensions", async () => {
  const gpu = await init();
  try {
    const line = texture(gpu, { kind: "1d", size: [4], format: "rgba8unorm", usage: ["storage_binding"] });
    const volume = texture(gpu, { kind: "3d", size: [4, 4, 4], format: "rgba16float", usage: ["storage_binding"] });
    const lineViews = vi.spyOn(line.gpu, "createView");
    const volumeViews = vi.spyOn(volume.gpu, "createView");
    compute(gpu, prepareShader(`
      @group(0) @binding(0) var line: texture_storage_1d<rgba8unorm, write>;
      @compute @workgroup_size(1) fn main() { textureStore(line, 0, vec4f(1)); }
    `), { set: { line } });
    compute(gpu, prepareShader(`
      @group(0) @binding(0) var volume: texture_storage_3d<rgba16float, write>;
      @compute @workgroup_size(1) fn main() { textureStore(volume, vec3u(0), vec4f(1)); }
    `), { set: { volume } });
    expect(lineViews).toHaveBeenCalledTimes(1);
    expect(volumeViews).toHaveBeenCalledTimes(1);
    expect(lineViews.mock.calls[0]![0]).toBeUndefined();
    expect(volumeViews.mock.calls[0]![0]).toBeUndefined();
  } finally {
    gpu.dispose();
  }
});

test("variant views share one destruction listener and clear synchronously", async () => {
  const gpu = await init();
  try {
    const mipped = texture(gpu, { kind: "2d", size: [4, 4], mipLevelCount: 3, format: "rgba8unorm", usage: ["texture_binding", "storage_binding"] });
    const listeners = vi.spyOn(mipped, "onDestroy");
    const storage = compute(gpu, prepareShader(STORAGE));
    storage.set({ destination: mipped });
    storage.set({ destination: mipped });
    expect(bindingViewCacheTestState(mipped)).toEqual({ variants: 1, destroyed: false });
    expect(listeners).toHaveBeenCalledTimes(1);
    mipped.destroy();
    expect(bindingViewCacheTestState(mipped)).toEqual({ variants: 0, destroyed: true });
    expect(() => storage.set({ destination: mipped })).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
  } finally {
    gpu.dispose();
  }
});

test("a pre-existing resource marker still invalidates generated variants", async () => {
  const gpu = await init();
  const cache = createBindGroupCache();
  try {
    const mipped = texture(gpu, { kind: "2d", size: [4, 4], mipLevelCount: 3, format: "rgba8unorm", usage: ["storage_binding"] });
    const listeners = vi.spyOn(mipped, "onDestroy");
    cache.marker(mipped, mipped.resourceIdentity, callback => mipped.onDestroy(callback));
    bindingTextureView(mipped, { dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }, cache, gpu.device);
    expect(listeners).toHaveBeenCalledTimes(1);
    expect(bindingViewCacheTestState(mipped)).toEqual({ variants: 1, destroyed: false });
    mipped.destroy();
    expect(bindingViewCacheTestState(mipped)).toEqual({ variants: 0, destroyed: true });
  } finally {
    cache.dispose();
    gpu.dispose();
  }
});

test("independent cache services reuse one texture-wide finite variant set", async () => {
  const gpu = await init();
  try {
    const mipped = texture(gpu, { kind: "2d", size: [4, 4], mipLevelCount: 3, format: "rgba8unorm", usage: ["storage_binding"] });
    const createView = vi.spyOn(mipped.gpu, "createView");
    const caches = Array.from({ length: 12 }, () => createBindGroupCache());
    const views = caches.map(cache => bindingTextureView(mipped, { dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }, cache, gpu!.device).view);
    expect(new Set(views).size).toBe(1);
    expect(createView).toHaveBeenCalledTimes(2);
    expect(bindingViewCacheTestState(mipped)).toEqual({ variants: 1, destroyed: false });
    for (const cache of caches) cache.dispose();
  } finally {
    gpu.dispose();
  }
});

test("cached non-default hits re-check the owning device", async () => {
  const gpu = await init();
  const device = gpu.device;
  const mipped = texture(gpu, { kind: "2d", size: [4, 4], mipLevelCount: 3, format: "rgba8unorm", usage: ["storage_binding"] });
  const cache = createBindGroupCache();
  const descriptor = { dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 } as const;
  bindingTextureView(mipped, descriptor, cache, device);
  gpu.dispose();
  expect(() => bindingTextureView(mipped, descriptor, cache, device)).toThrowError(
    expect.objectContaining({ code: "VGPU-CORE-TEXTURE-DESTROYED" }),
  );
  cache.dispose();
});

test("non-default hits check the Texture owner independently from the consuming Device", async () => {
  const owner = await init();
  const consumer = await init();
  const source = texture(owner, { kind: "2d", size: [4, 4], mipLevelCount: 3, format: "rgba8unorm", usage: ["storage_binding"] });
  const cache = createBindGroupCache();
  const descriptor = { dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 } as const;
  try {
    bindingTextureView(source, descriptor, cache, consumer.device);
    owner.dispose();
    expect(() => bindingTextureView(source, descriptor, cache, consumer.device)).toThrowError(
      expect.objectContaining({ code: "VGPU-CORE-TEXTURE-DESTROYED" }),
    );
  } finally {
    cache.dispose();
    consumer.dispose();
    owner.dispose();
  }
});

test("a followed Target selects a new texture-keyed view after replacement", async () => {
  const gpu = await init();
  try {
    const source = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const oldTexture = source.color;
    const oldViews = vi.spyOn(oldTexture.gpu, "createView");
    const sampled = effect(gpu, prepareShader(SAMPLE), { set: { source } });
    expect(oldViews).toHaveBeenCalledTimes(1);
    source.resize([8, 8]);
    const replacement = source.color;
    const replacementViews = vi.spyOn(replacement.gpu, "createView");
    frame(gpu, current => current.pass(output, pass => pass.draw(sampled)));
    expect(replacementViews).toHaveBeenCalledTimes(1);
    expect(replacement).not.toBe(oldTexture);
  } finally {
    gpu.dispose();
  }
});

function getBindingResource(drawable: ReturnType<typeof effect>, gpu: Awaited<ReturnType<typeof init>>): GPUBindingResource {
  const output = target(gpu, { size: [1, 1] });
  drawable.draw(output);
  return getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors.at(-1)!.entries[0]!.resource;
}
