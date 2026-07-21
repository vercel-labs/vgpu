import { expect, test, vi } from "vitest";
import { bindGroupLayoutMetadata, createMockGPUDevice, Device } from "@vgpu/core";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { bindGroupLayoutEntriesForGroup, visibilityForEntries } from "../src/set-layouts.ts";
import { init } from "../src/mock.ts";

const vertexShader = (name: string) => `
@group(0) @binding(0) var<uniform> ${name}: vec4f;
@vertex fn vs() -> @builtin(position) vec4f { return ${name}; }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
`;
const fragmentShader = `
@group(0) @binding(0) var<uniform> value: vec4f;
@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
@fragment fn fs() -> @location(0) vec4f { return value; }
`;

test("equal visibility layouts reuse identity while distinct masks do not poison the cache", async () => {
  const gpu = await init();
  const a = gpu.draw({ shader: vertexShader("a"), label: "cache-a" });
  const b = gpu.draw({ shader: vertexShader("b"), label: "cache-b" });
  const fragment = gpu.draw({ shader: fragmentShader, label: "cache-fragment" });
  expect(a.layout(0)).toBe(b.layout(0));
  expect(fragment.layout(0)).not.toBe(a.layout(0));
  gpu.dispose();
});

test("unused bindings may be set and are ignored by the omitted layout", async () => {
  const gpu = await init();
  const shader = `
    @group(0) @binding(0) var<storage, read> unused: array<u32>;
    @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
  `;
  const draw = gpu.draw({ shader, label: "unused-set" });
  expect(() => draw.set({ unused: gpu.storage(16, "read") })).not.toThrow();
  const target = gpu.target({ size: [1, 1] });
  expect(() => gpu.frame((frame) => frame.pass(target, (pass) => pass.draw(draw)))).not.toThrow();
  gpu.dispose();
});

test("changing an omitted binding does not stale a recorded bundle", async () => {
  const gpu = await init();
  const shader = `
    @group(0) @binding(0) var<uniform> used: vec4f;
    @group(0) @binding(1) var<storage, read> unused: array<u32>;
    @vertex fn vs() -> @builtin(position) vec4f { return used; }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
  `;
  const draw = gpu.draw({ shader, label: "inactive-bundle", set: { used: [0, 0, 0, 1], unused: gpu.storage(16, "read") } });
  const target = gpu.target({ size: [1, 1] });
  const bundle = gpu.bundle({ target, label: "inactive-bundle-recording" }, (recorder) => recorder.draw(draw));
  draw.set({ unused: gpu.storage(16, "read") });
  expect(() => gpu.frame((frame) => frame.pass(target, (pass) => pass.bundles(bundle)))).not.toThrow();
  gpu.dispose();
});

test("unused-only high groups require no pipeline layouts", async () => {
  const gpu = await init();
  const shader = `
    @group(1) @binding(0) var<storage, read> unused: array<u32>;
    @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
  `;
  const draw = gpu.draw({ shader, label: "unused-group-one" });
  const target = gpu.target({ size: [1, 1] });
  expect(() => gpu.frame((frame) => frame.pass(target, (pass) => pass.draw(draw)))).not.toThrow();
  gpu.dispose();
});

test("equal dynamic descriptors reuse layout identity", async () => {
  const gpu = await init();
  const a = gpu.draw({ shader: vertexShader("a"), label: "dynamic-a" });
  const b = gpu.draw({ shader: vertexShader("b"), label: "dynamic-b" });
  expect(a.layout(0, { dynamicOffsets: true })).toBe(b.layout(0, { dynamicOffsets: true }));
  gpu.dispose();
});

test("bundle recording and mesh slices share narrowed pipeline layouts", async () => {
  const gpu = await init();
  const mesh = gpu.mesh({ buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }] });
  const first = gpu.draw({ shader: vertexShader("first"), label: "mesh-first", mesh });
  const second = gpu.draw({ shader: vertexShader("second"), label: "mesh-second", mesh: mesh.slice({ firstVertex: 0, vertexCount: 3 }) });
  first.set({ first: [0, 0, 0, 1] });
  second.set({ second: [0, 0, 0, 1] });
  expect(first.layout(0)).toBe(second.layout(0));
  const target = gpu.target({ size: [2, 2] });
  expect(() => gpu.bundle({ target, label: "narrowed-bundle" }, (bundle) => { bundle.draw(first); bundle.draw(second); })).not.toThrow();
  gpu.dispose();
});

const sampledTextureShader = (sample: boolean) => `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
@fragment fn fs() -> @location(0) vec4f { return ${sample ? "textureSampleLevel(image, imageSampler, vec2f(0), 0)" : "textureLoad(image, vec2i(0), 0)"}; }
`;

test("ordinary sampling promotes f32 texture layouts while loads remain unfilterable", async () => {
  const gpu = await init();
  const loaded = gpu.draw({ shader: sampledTextureShader(false), label: "loaded-f32" });
  const sampled = gpu.draw({ shader: sampledTextureShader(true), label: "sampled-f32" });
  const again = gpu.draw({ shader: sampledTextureShader(true), label: "sampled-again" });
  const loadedEntry = bindGroupLayoutMetadata(loaded.layout(0))?.entries;
  const sampledEntry = bindGroupLayoutMetadata(sampled.layout(0))?.entries;
  expect(loadedEntry?.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("unfilterable-float");
  expect(sampledEntry?.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("float");
  expect(sampled.layout(0)).toBe(again.layout(0));
  expect(sampled.layout(0)).not.toBe(loaded.layout(0));
  gpu.dispose();
});

test("known unfilterable float textures fail with an actionable structured error", async () => {
  const gpu = await init();
  const draw = gpu.draw({ shader: sampledTextureShader(true), label: "filterability" });
  const hdr = gpu.device.createTexture({ size: [1, 1], format: "rgba32float", usage: ["texture_binding"], label: "hdr-color" });
  expect(() => draw.set({ image: hdr })).toThrow(expect.objectContaining({
    code: "VGPU-SET-TEXTURE-FILTERABILITY",
    where: "filterability.set",
    message: expect.stringContaining("hdr-color (rgba32float)"),
    fix: expect.stringContaining("float32-filterable"),
    detail: {
      format: "rgba32float", group: 0, binding: 0, bindingName: "image", resourceName: "hdr-color",
      samplerName: "imageSampler", samplerGroup: 0, samplerBinding: 1,
    },
  }));
  gpu.dispose();
});

test("requested float32-filterable permits promoted rgba32float facade textures", async () => {
  const device = createMockGPUDevice();
  Object.defineProperty(device, "features", { value: new Set<GPUFeatureName>(["float32-filterable"]) });
  const requestDevice = vi.fn(async () => new Device(device));
  const gpu = await init({ adapter: { requestDevice }, requiredFeatures: ["float32-filterable"] });
  const draw = gpu.draw({ shader: sampledTextureShader(true), label: "feature-enabled" });
  const hdr = gpu.device.createTexture({ size: [1, 1], format: "rgba32float", usage: ["texture_binding"], label: "filterable-hdr" });
  expect(bindGroupLayoutMetadata(draw.layout(0))?.entries.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("float");
  expect(() => draw.set({ image: hdr, imageSampler: gpu.sampler({ minFilter: "linear" }) })).not.toThrow();
  expect(requestDevice).toHaveBeenCalledWith(expect.objectContaining({ requiredFeatures: ["float32-filterable"] }));
  gpu.dispose();
});

test("unresolved direct and helper sampling promote the positional texture bindings", async () => {
  const gpu = await init();
  const direct = gpu.draw({ label: "fallback-direct", shader: `
    @group(0) @binding(0) var image: texture_2d<f32>;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var other: texture_2d<f32>;
    @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
    @fragment fn fs() -> @location(0) vec4f { let image = image; return textureSample(image, samp, vec2f(textureDimensions(other))); }
  ` });
  const helper = gpu.draw({ label: "fallback-helper", shader: `
    @group(0) @binding(0) var image: texture_2d<f32>;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var other: texture_2d<f32>;
    fn sampleIt(t: texture_2d<f32>, s: sampler, q: texture_2d<f32>) -> vec4f { let t = t; return textureSample(t, s, vec2f(textureDimensions(q))); }
    @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
    @fragment fn fs() -> @location(0) vec4f { return sampleIt(image, samp, other); }
  ` });
  for (const draw of [direct, helper]) {
    const entries = bindGroupLayoutMetadata(draw.layout(0))!.entries;
    expect(entries.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("float");
    expect(entries.find((entry) => entry.binding === 2)?.texture?.sampleType).toBe("float");
  }
  gpu.dispose();
});

test("selected vertex load and fragment sample union only promotes the sampled texture", async () => {
  const gpu = await init();
  const draw = gpu.draw({ label: "mixed-entry-policy", shader: `
    @group(0) @binding(0) var sampled: texture_2d<f32>;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var loaded: texture_2d<f32>;
    @vertex fn vs() -> @builtin(position) vec4f { return textureLoad(loaded, vec2i(0), 0); }
    @fragment fn fs() -> @location(0) vec4f { return textureSampleLevel(sampled, samp, vec2f(0), 0); }
  ` });
  const entries = bindGroupLayoutMetadata(draw.layout(0))!.entries;
  expect(entries.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("float");
  expect(entries.find((entry) => entry.binding === 2)?.texture?.sampleType).toBe("unfilterable-float");
  expect(entries.find((entry) => entry.binding === 0)?.visibility).toBe(2);
  expect(entries.find((entry) => entry.binding === 2)?.visibility).toBe(1);
  gpu.dispose();
});

test("depth integer external storage and multisampled layouts are never promoted", async () => {
  const gpu = await init();
  const draw = gpu.draw({ label: "special-textures", shader: `
    @group(0) @binding(0) var depthTex: texture_depth_2d;
    @group(0) @binding(1) var comparison: sampler_comparison;
    @group(0) @binding(2) var sintTex: texture_2d<i32>;
    @group(0) @binding(3) var uintTex: texture_2d<u32>;
    @group(0) @binding(4) var msTex: texture_multisampled_2d<f32>;
    @group(0) @binding(5) var storageTex: texture_storage_2d<rgba8unorm, write>;
    @group(0) @binding(6) var externalTex: texture_external;
    @group(0) @binding(7) var ordinary: sampler;
    @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
    @fragment fn fs() -> @location(0) vec4f {
      textureStore(storageTex, vec2i(0), vec4f(1));
      return vec4f(textureSampleCompare(depthTex, comparison, vec2f(0), 0))
        + vec4f(textureLoad(sintTex, vec2i(0), 0))
        + vec4f(textureLoad(uintTex, vec2i(0), 0))
        + textureLoad(msTex, vec2i(0), 0)
        + textureSampleBaseClampToEdge(externalTex, ordinary, vec2f(0));
    }
  ` });
  const entries = bindGroupLayoutMetadata(draw.layout(0))!.entries;
  expect(entries.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("depth");
  expect(entries.find((entry) => entry.binding === 2)?.texture?.sampleType).toBe("sint");
  expect(entries.find((entry) => entry.binding === 3)?.texture?.sampleType).toBe("uint");
  expect(entries.find((entry) => entry.binding === 4)?.texture).toMatchObject({ sampleType: "unfilterable-float", multisampled: true });
  expect(entries.find((entry) => entry.binding === 5)?.storageTexture).toBeDefined();
  expect(entries.find((entry) => entry.binding === 6)?.externalTexture).toBeDefined();
  gpu.dispose();
});

test("equal effective descriptors are isolated across devices", async () => {
  const firstGpu = await init(), secondGpu = await init();
  const first = firstGpu.draw({ shader: sampledTextureShader(true), label: "same-label" });
  const second = secondGpu.draw({ shader: sampledTextureShader(true), label: "same-label" });
  expect(first.layout(0)).not.toBe(second.layout(0));
  firstGpu.dispose(); secondGpu.dispose();
});

test("effective promotion does not mutate reflected binding layouts", () => {
  const reflection = reflectSource(sampledTextureShader(true));
  const texture = reflection.bindings[0]!;
  expect(texture.bindingLayout).toMatchObject({ kind: "texture", texture: { sampleType: "unfilterable-float" } });
  const policy = visibilityForEntries(reflection.bindings, reflection.entryPoints);
  expect(bindGroupLayoutEntriesForGroup(reflection.bindings, 0, policy)[0]?.texture?.sampleType).toBe("float");
  expect(texture.bindingLayout).toMatchObject({ kind: "texture", texture: { sampleType: "unfilterable-float" } });
});

test("opaque raw texture views skip facade format prechecks", async () => {
  const gpu = await init();
  const draw = gpu.draw({ shader: sampledTextureShader(true), label: "raw-view-fallback" });
  const raw = gpu.device.gpu.createTexture({ size: [1, 1], format: "rgba32float", usage: 4 }).createView();
  expect(() => draw.set({ image: raw, imageSampler: gpu.sampler() })).not.toThrow();
  gpu.dispose();
});
