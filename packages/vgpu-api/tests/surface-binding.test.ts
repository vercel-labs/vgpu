import { prepareShader } from "@vgpu/wgsl/prepare";
import { expect, test, vi } from "vitest";
import type { Target } from "../src/target.ts";
import { compute, draw, effect, frame, init, sampler, surface, target, texture } from "../src/mock.ts";

const SAMPLED_DRAW = `
@group(0) @binding(0) var source: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }
`;

const SAMPLER_EFFECT = `
@group(0) @binding(0) var sourceSampler: sampler;
fn useSampler(value: sampler) {}
@fragment fn fs() -> @location(0) vec4f { useSampler(sourceSampler); return vec4f(1); }
`;

const STORAGE_COMPUTE = `
@group(0) @binding(0) var destination: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(1) fn main() { textureStore(destination, vec2i(0), vec4f(1)); }
`;

const UNIFORM_EFFECT = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs() -> @location(0) vec4f { return vec4f(params.value); }
`;

const DEPTH_EFFECT = `
@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@fragment fn fs() -> @location(0) vec4f {
  let depth = textureLoad(sceneDepth, vec2i(0), 0);
  return vec4f(depth);
}
`;

test("Draw, Effect, and Compute reject Surface in constructors and later set, inside and outside frames", async () => {
  const gpu = await init();
  try {
    const { canvasSurface, getCurrentTexture } = createSurface(gpu);
    const guardedSurface = rejectAttachmentReads(canvasSurface);
    const cases = [
      { label: "sampled-draw", binding: "source", create: (set?: Record<string, unknown>) => draw(gpu, { shader: prepareShader(SAMPLED_DRAW), label: "sampled-draw", set }) },
      { label: "sampler-effect", binding: "sourceSampler", create: (set?: Record<string, unknown>) => effect(gpu, prepareShader(SAMPLER_EFFECT), { label: "sampler-effect", set }) },
      { label: "storage-compute", binding: "destination", create: (set?: Record<string, unknown>) => compute(gpu, prepareShader(STORAGE_COMPUTE), { label: "storage-compute", set }) },
    ];

    for (const item of cases) {
      expectSurfaceError(() => item.create({ [item.binding]: guardedSurface }), item.label, item.binding);
    }
    frame(gpu, () => {
      for (const item of cases) expectSurfaceError(() => item.create({ [item.binding]: guardedSurface }), item.label, item.binding);
    });

    const instances = cases.map((item) => ({ item, instance: item.create() }));
    for (const { item, instance } of instances) {
      expectSurfaceError(() => instance.set({ [item.binding]: guardedSurface }), item.label, item.binding);
    }
    frame(gpu, () => {
      for (const { item, instance } of instances) {
        expectSurfaceError(() => instance.set({ [item.binding]: guardedSurface }), item.label, item.binding);
      }
    });
    expect(getCurrentTexture).not.toHaveBeenCalled();
  } finally { gpu.dispose(); }
});

test("a JS-owned buffer cannot bypass Surface rejection and remains usable after the failed set", async () => {
  const gpu = await init();
  try {
    const { canvasSurface, getCurrentTexture } = createSurface(gpu);
    const output = target(gpu, { size: [4, 4] });
    const shader = effect(gpu, prepareShader(UNIFORM_EFFECT), { label: "uniform-effect", set: { params: { value: 0.25 } } });

    expect(() => shader.set({ params: canvasSurface })).toThrowError(expect.objectContaining({
      code: "VGPU-SURFACE-NOT-BINDABLE",
      where: "uniform-effect.params",
    }));
    expect(getCurrentTexture).not.toHaveBeenCalled();
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass(output, shader))).not.toThrow();
  } finally { gpu.dispose(); }
});

test("a failed Surface set preserves a sampled Target binding and follows its replacement", async () => {
  const gpu = await init();
  try {
    const { canvasSurface, getCurrentTexture } = createSurface(gpu);
    const source = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const original = source.color;
    const post = effect(gpu, prepareShader(SAMPLED_DRAW), { label: "post", set: { source } });

    expectSurfaceError(() => post.set({ source: canvasSurface }), "post", "source");
    source.resize([8, 8]);
    const replacement = source.color;
    const replacementViews = vi.spyOn(replacement.gpu, "createView");
    expect(replacement).not.toBe(original);
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass(output, post))).not.toThrow();
    expect(replacementViews).toHaveBeenCalledTimes(1);
    expect(getCurrentTexture).not.toHaveBeenCalled();
  } finally { gpu.dispose(); }
});

test("disposed Surfaces and depth slots reject before attachment getter access", async () => {
  const gpu = await init();
  try {
    const { canvasSurface, getCurrentTexture } = createSurface(gpu);
    const depthTarget = target(gpu, { size: [4, 4], depth: true });
    const output = target(gpu, { size: [4, 4] });
    const post = effect(gpu, prepareShader(DEPTH_EFFECT), { label: "depth-post", set: { sceneDepth: depthTarget } });
    canvasSurface.dispose();

    expectSurfaceError(() => post.set({ sceneDepth: canvasSurface }), "depth-post", "sceneDepth");
    expect(getCurrentTexture).not.toHaveBeenCalled();
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass(output, post))).not.toThrow();
  } finally { gpu.dispose(); }
});

test("ordinary and custom Targets keep following replacement textures", async () => {
  const gpu = await init();
  try {
    const ordinary = target(gpu, { size: [4, 4] });
    const backing = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const custom = customTarget(backing);
    const ordinaryPost = effect(gpu, prepareShader(SAMPLED_DRAW), { set: { source: ordinary } });
    const customPost = effect(gpu, prepareShader(SAMPLED_DRAW), { set: { source: custom } });

    ordinary.resize([8, 8]);
    backing.resize([8, 8]);
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass(output, (pass) => {
      pass.draw(ordinaryPost);
      pass.draw(customPost);
    }))).not.toThrow();
  } finally { gpu.dispose(); }
});

test("explicit Textures, the current-frame Surface color escape, and Surface color readback remain supported", async () => {
  const gpu = await init();
  try {
    const { canvasSurface, getCurrentTexture } = createSurface(gpu);
    const explicit = texture(gpu, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["texture_binding"] });
    const storage = texture(gpu, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["storage_binding"] });
    const output = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, prepareShader(SAMPLED_DRAW), { label: "sampled", set: { source: explicit } });
    const stored = compute(gpu, prepareShader(STORAGE_COMPUTE), { label: "stored", set: { destination: storage } });
    const sampledWithSampler = effect(gpu, prepareShader(SAMPLER_EFFECT), { set: { sourceSampler: sampler(gpu) } });

    expect(() => stored.dispatch(1)).not.toThrow();
    expect(() => frame(gpu, (currentFrame) => {
      sampled.set({ source: canvasSurface.color });
      currentFrame.pass(canvasSurface, () => undefined);
      currentFrame.pass(output, sampled);
    })).not.toThrow();
    expect(sampledWithSampler).toBeDefined();
    await expect(canvasSurface.color.read({ mipLevel: 0, region: "all" })).resolves.toHaveLength(4 * 4 * 4);
    expect(getCurrentTexture).toHaveBeenCalledTimes(4);
  } finally { gpu.dispose(); }
});

function expectSurfaceError(action: () => unknown, label: string, binding: string): void {
  expect(action).toThrowError(expect.objectContaining({
    code: "VGPU-SURFACE-NOT-BINDABLE",
    message: `Binding '${binding}' (@group(0) @binding(0)) in '${label}' cannot use a Surface as an input.`,
    where: `${label}.${binding}`,
    fix: "Render to an offscreen target and bind that target or its texture. Use Surface only as a render destination.",
    detail: { binding: 0, bindingName: binding },
  }));
}

function rejectAttachmentReads<T extends object>(canvasSurface: T): T {
  return new Proxy(canvasSurface, {
    get(target, property, receiver) {
      if (property === "color" || property === "colors" || property === "depth") {
        throw new Error(`Surface attachment getter '${property}' was read before rejection.`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function createSurface(gpu: Awaited<ReturnType<typeof init>>) {
  const presentation = gpu.device.createTexture({
    kind: "2d",
    size: [4, 4],
    format: "rgba8unorm",
    usage: ["render_attachment", "texture_binding", "copy_src"],
  });
  const getCurrentTexture = vi.fn(() => presentation.gpu);
  const canvas = {
    width: 4,
    height: 4,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return { canvas, configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture };
    },
  } as unknown as OffscreenCanvas;
  return { canvasSurface: surface(gpu, canvas, { size: [4, 4], format: "rgba8unorm" }), getCurrentTexture };
}

function customTarget(backing: Target): Target {
  const targetWithRecreation = backing as Target & { onTexturesRecreated(cb: () => void): () => void };
  return {
    get gpu() { return backing.gpu; },
    get size() { return backing.size; },
    get texelSize() { return backing.texelSize; },
    get color() { return backing.color; },
    get colors() { return backing.colors; },
    get depth() { return backing.depth; },
    get format() { return backing.format; },
    get sampleCount() { return backing.sampleCount; },
    get clearColor() { return backing.clearColor; },
    set clearColor(value) { backing.clearColor = value; },
    resourceIdentity: backing.resourceIdentity,
    resize: (size) => backing.resize(size),
    onDestroy: (cb) => backing.onDestroy(cb),
    renderPassDescriptor: (opts) => backing.renderPassDescriptor(opts),
    onTexturesRecreated: (cb: () => void) => targetWithRecreation.onTexturesRecreated(cb),
  } as Target;
}
