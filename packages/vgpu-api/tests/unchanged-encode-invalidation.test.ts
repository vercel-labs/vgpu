import { prepareShader } from "@vgpu/wgsl/prepare";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bindGroupCacheTestState } from "../src/bind-cache.ts";
import { drawCacheOwnerTestState, type InternalDraw } from "../src/draw.ts";
import { bundle, compute, effect, frame, getMockGPUDeviceInstrumentation, init, target, texture, uniforms, type Draw } from "../src/mock.ts";
import { issueWorkload, recordBindings, uniformBuffer } from "./fixtures/unchanged-encode.ts";

const SAMPLE = `@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(src, vec2i(0), 0); }`;
const STORAGE = `@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(1) fn main() { values[0] += 1u; }`;
const TINT = `struct Tint { value: vec4f }
@group(0) @binding(0) var<uniform> tint: Tint;
@fragment fn main() -> @location(0) vec4f { return tint.value; }`;

const destroyed = (pattern?: RegExp) => expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED", ...(pattern ? { message: expect.stringMatching(pattern) } : {}) });

afterEach(() => vi.restoreAllMocks());

/** Warms the issue workload so every case starts from cached bind groups, plans and pipeline keys. */
async function warm(count = 2) {
  const gpu = await init();
  const workload = issueWorkload(gpu, count);
  const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
  const recorded = recordBindings(gpu);
  const render = (draws: readonly Draw[] = workload.draws) => frame(gpu, (f) => f.pass({ target: workload.out }, (p) => { for (const item of draws) p.draw(item); }));
  for (let index = 0; index < 3; index++) render();
  return { gpu, ...workload, mock, recorded, render };
}

// Characterization matrix for issue #489: every transition the unchanged-encode fast path must
// observe. Green before and after the optimization; counters are asserted in the hot-path gates.
describe("unchanged encode invalidation", () => {
  test("I1: destroying a bound resource fails the very next encode, including shared and one-shot paths", async () => {
    const { gpu, draws, objects, frameBuffer, out, mock, render } = await warm();
    try {
      const groups = mock.calls.createBindGroup;
      objects[1]!.destroy();
      expect(() => render([draws[1]!])).toThrowError(destroyed(/'object'.*'draw1'.*'object1'/));
      expect(() => render([draws[0]!])).not.toThrow();
      const encoders = mock.calls.createCommandEncoder;
      expect(() => draws[1]!.draw(out)).toThrowError(destroyed());
      expect(mock.calls.createCommandEncoder).toBe(encoders);
      frameBuffer.destroy();
      expect(() => render([draws[0]!])).toThrowError(destroyed(/'frame'.*'draw0'.*'frame'/));
      expect(mock.calls.createBindGroup).toBe(groups);
    } finally { gpu.dispose(); }
  });

  test("I1: destroyed textures, followed Targets and Target attachments fail the next encode after warm-up", async () => {
    const gpu = await init();
    try {
      const out = target(gpu, { size: [4, 4] });
      const image = texture(gpu, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["texture_binding"], label: "image" });
      const source = target(gpu, { size: [4, 4] });
      const attachment = target(gpu, { size: [4, 4] });
      const byTexture = effect(gpu, prepareShader(SAMPLE), { label: "byTexture", set: { src: image } });
      const byTarget = effect(gpu, prepareShader(SAMPLE), { label: "byTarget", set: { src: source } });
      const byAttachment = effect(gpu, prepareShader(SAMPLE), { label: "byAttachment", set: { src: attachment } });
      const render = (fx: typeof byTexture) => frame(gpu, (f) => f.pass(out, (p) => p.draw(fx)));
      for (let index = 0; index < 3; index++) { render(byTexture); render(byTarget); render(byAttachment); }
      image.destroy();
      expect(() => render(byTexture)).toThrowError(destroyed(/'src'.*'byTexture'.*'image'/));
      (source as typeof source & { destroy(): void }).destroy();
      expect(() => render(byTarget)).toThrowError(destroyed());
      attachment.color.destroy();
      expect(() => render(byAttachment)).toThrowError(destroyed());
    } finally { gpu.dispose(); }
  });

  test("I2/I3/I4: set() recovery, same-value set, rejected set and A→B→A reuse", async () => {
    const { gpu, draws: [item], objects, mock, recorded, render } = await warm(1);
    try {
      const original = recorded.bound.findLast((entry) => entry.group === 1)!.bindGroup;
      let groups = mock.calls.createBindGroup;
      item!.set({ object: objects[0]! });
      render();
      expect(mock.calls.createBindGroup).toBe(groups);
      const dead = uniformBuffer(gpu, 64, "dead");
      dead.destroy();
      expect(() => item!.set({ object: dead })).toThrowError(destroyed());
      expect(() => item!.set({ object: gpu.device.createBuffer({ size: 64, usage: ["storage"] }) })).toThrow();
      render();
      expect(mock.calls.createBindGroup).toBe(groups);
      expect(recorded.bound.findLast((entry) => entry.group === 1)!.bindGroup).toBe(original);
      const fresh = uniformBuffer(gpu, 64, "fresh");
      item!.set({ object: fresh });
      render();
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      render();
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      item!.set({ object: objects[0]! });
      render();
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      expect(recorded.bound.findLast((entry) => entry.group === 1)!.bindGroup).toBe(original);
      objects[0]!.destroy();
      expect(() => render()).toThrowError(destroyed());
      item!.set({ object: fresh });
      groups = mock.calls.createBindGroup;
      render();
      expect(mock.calls.createBindGroup).toBe(groups);
    } finally { gpu.dispose(); }
  });

  test("I5: a dynamic-offset layout after warm-up retires the group's entries and the pipeline key", async () => {
    const { gpu, draws: [item], mock, out } = await warm(1);
    try {
      const internal = item as InternalDraw;
      const { cache, owner } = drawCacheOwnerTestState(internal);
      const entries = bindGroupCacheTestState(cache).ownerEntries(owner);
      const pipelines = mock.calls.createRenderPipeline;
      item!.layout(1, { dynamicOffsets: true });
      expect(bindGroupCacheTestState(cache).ownerEntries(owner)).toBe(entries - 1);
      const render = () => frame(gpu, (f) => f.pass({ target: out }, (p) => p.draw(item!, { offsets: { 1: [0] } })));
      render();
      expect(mock.calls.createRenderPipeline).toBe(pipelines + 1);
      const groups = mock.calls.createBindGroup;
      render(); render();
      expect(mock.calls.createRenderPipeline).toBe(pipelines + 1);
      expect(mock.calls.createBindGroup).toBe(groups);
    } finally { gpu.dispose(); }
  });

  test("I6: claiming a group after warm-up binds the raw group and rejects set() on it", async () => {
    const { gpu, draws: [item], objects, recorded, render } = await warm(1);
    try {
      const raw = gpu.gpu.createBindGroup({ layout: item!.layout(1), entries: [{ binding: 0, resource: { buffer: objects[0]!.gpu, offset: 0, size: 64 } }] });
      item!.group(1, raw);
      render();
      expect(recorded.bound.findLast((entry) => entry.group === 1)!.bindGroup).toBe(raw);
      expect(() => item!.set({ object: uniformBuffer(gpu, 64) })).toThrowError(expect.objectContaining({ code: "VGPU-R4-GROUP-CLAIMED" }));
      const other = gpu.gpu.createBindGroup({ layout: item!.layout(1), entries: [{ binding: 0, resource: { buffer: uniformBuffer(gpu, 64).gpu, offset: 0, size: 64 } }] });
      item!.group(1, other);
      render();
      expect(recorded.bound.findLast((entry) => entry.group === 1)!.bindGroup).toBe(other);
    } finally { gpu.dispose(); }
  });

  test("I7: followed Targets pick up replacements after warm-up; fixed attachment bindings fail", async () => {
    const gpu = await init();
    try {
      const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
      const recorded = recordBindings(gpu);
      const source = target(gpu, { size: [4, 4] });
      const out = target(gpu, { size: [4, 4] });
      const followed = effect(gpu, prepareShader(SAMPLE), { label: "followed", set: { src: source } });
      const fixed = effect(gpu, prepareShader(SAMPLE), { label: "fixed", set: { src: source.color } });
      const render = (fx: typeof followed) => frame(gpu, (f) => f.pass(out, (p) => p.draw(fx)));
      for (let index = 0; index < 3; index++) { render(followed); render(fixed); }
      const groups = mock.calls.createBindGroup;
      source.resize([4, 4]);
      render(followed);
      expect(mock.calls.createBindGroup).toBe(groups);
      source.resize([8, 8]);
      render(followed);
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      const view = [...recorded.descriptors.get(recorded.bound.at(-1)!.bindGroup)!.entries][0]!.resource;
      expect(view).toBe(source.color.view);
      render(followed);
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      expect(() => render(fixed)).toThrowError(destroyed(/'fixed'/));
    } finally { gpu.dispose(); }
  });

  test("I8: shared uniform revisions after warm-up bind the new value; unchanged revisions share one group per frame", async () => {
    const gpu = await init();
    try {
      const recorded = recordBindings(gpu);
      const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
      const shared = uniforms(gpu, { value: [1, 0, 0, 1] });
      const fx = effect(gpu, prepareShader(TINT), { set: { tint: shared } });
      const out = target(gpu, { size: [4, 4] });
      const render = () => frame(gpu, (f) => f.pass(out, (p) => p.draw(fx)));
      for (let index = 0; index < 3; index++) render();
      for (let value = 2; value < 6; value++) {
        shared.set({ value: [value, 0, 0, 1] });
        render();
        expect(recorded.lastFloat(0)).toBe(value);
      }
      await gpu.settled();
      const groups = mock.calls.createBindGroup;
      render(); render();
      expect(recorded.lastFloat(0)).toBe(5);
      expect(mock.calls.createBindGroup).toBe(groups);
      const first = recorded.bound.length;
      frame(gpu, (f) => f.pass(out, (p) => { p.draw(fx); p.draw(fx); }));
      expect(recorded.bound[first]!.bindGroup).toBe(recorded.bound[first + 1]!.bindGroup);
      shared.set({ value: [6, 0, 0, 1] });
      frame(gpu, (f) => f.pass(out, (p) => { p.draw(fx); shared.set({ value: [7, 0, 0, 1] }); p.draw(fx); }));
      expect(recorded.bound.at(-2)!.bindGroup).not.toBe(recorded.bound.at(-1)!.bindGroup);
      expect(recorded.lastFloat(0)).toBe(7);
    } finally { gpu.dispose(); }
  });

  test("I9: per-owner LRU bounds hold under rebinding; hits refresh recency and evicted variants rebuild", async () => {
    const { gpu, draws: [item], mock, render } = await warm(1);
    try {
      const { cache, owner } = drawCacheOwnerTestState(item as InternalDraw);
      const entries = () => bindGroupCacheTestState(cache).ownerEntries(owner);
      const buffers = Array.from({ length: 70 }, (_, index) => uniformBuffer(gpu, 64, `variant${index}`));
      const encodeWith = (index: number) => { item!.set({ object: buffers[index]! }); render(); };
      // Groups 0 and 2 hold one entry each; 62 group 1 variants fill the 64-entry owner bound.
      for (let index = 0; index < 62; index++) encodeWith(index);
      expect(entries()).toBe(64);
      encodeWith(0);
      encodeWith(62);
      expect(entries()).toBe(64);
      let groups = mock.calls.createBindGroup;
      encodeWith(0);
      expect(mock.calls.createBindGroup).toBe(groups);
      encodeWith(1);
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      for (let index = 63; index < 70; index++) encodeWith(index);
      expect(entries()).toBeLessThanOrEqual(64);
      groups = mock.calls.createBindGroup;
      encodeWith(69);
      expect(mock.calls.createBindGroup).toBe(groups);
    } finally { gpu.dispose(); }
  });

  test("I10: external cache eviction under a warm draw recreates exactly one bind group with the same resources", async () => {
    const { gpu, draws: [item], objects, mock, recorded, render } = await warm(1);
    try {
      const { cache, owner } = drawCacheOwnerTestState(item as InternalDraw);
      const resources = () => [...recorded.descriptors.get(recorded.bound.findLast((entry) => entry.group === 1)!.bindGroup)!.entries][0]!.resource;
      const before = resources();
      let groups = mock.calls.createBindGroup;
      cache.clearOwner(owner, 1);
      render();
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      expect(resources()).toEqual(before);
      render();
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      groups = mock.calls.createBindGroup;
      cache.evictIdentity(objects[0]!.resourceIdentity);
      render();
      expect(mock.calls.createBindGroup).toBe(groups + 1);
      expect(resources()).toEqual(before);
    } finally { gpu.dispose(); }
  });

  test("I11: bundles recorded from a warm draw go stale on set, destruction and claims", async () => {
    const { gpu, draws: [item], objects, out, render } = await warm(1);
    try {
      const record = () => bundle(gpu, { target: out }, (b) => b.draw(item!));
      const replay = (recorded: ReturnType<typeof record>) => frame(gpu, (f) => f.pass({ target: out }, (p) => p.bundles(recorded)));
      const stale = expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" });
      let recorded = record();
      expect(() => replay(recorded)).not.toThrow();
      item!.set({ object: uniformBuffer(gpu, 64) });
      expect(() => replay(recorded)).toThrowError(stale);
      item!.set({ object: objects[0]! });
      recorded = record();
      render();
      objects[0]!.destroy();
      expect(() => replay(recorded)).toThrowError(stale);
      expect(() => render()).toThrowError(destroyed());
      item!.set({ object: uniformBuffer(gpu, 64) });
      recorded = record();
      render();
      item!.group(1, gpu.gpu.createBindGroup({ layout: item!.layout(1), entries: [{ binding: 0, resource: { buffer: uniformBuffer(gpu, 64).gpu, offset: 0, size: 64 } }] }));
      expect(() => replay(recorded)).toThrowError(stale);
    } finally { gpu.dispose(); }
  });

  test("I12: a warm compute fails before encoding when its storage buffer is destroyed and recovers on set", async () => {
    const gpu = await init();
    try {
      const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
      const values = gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst"], label: "values" });
      const sim = compute(gpu, prepareShader(STORAGE), { label: "sim", set: { values } });
      for (let index = 0; index < 3; index++) sim.dispatch(1);
      values.destroy();
      const encoders = mock.calls.createCommandEncoder;
      expect(() => sim.dispatch(1)).toThrowError(destroyed(/'values'.*'sim'.*'values'/));
      expect(() => frame(gpu, (f) => f.computePass((p) => p.dispatch(sim, 1)))).toThrowError(destroyed());
      expect(mock.calls.createCommandEncoder).toBe(encoders + 1);
      sim.set({ values: gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst"] }) });
      expect(() => sim.dispatch(1)).not.toThrow();
    } finally { gpu.dispose(); }
  });

  test("I13: disposal after warm-up surfaces the same errors on the next encode", async () => {
    const { gpu, draws, render, out } = await warm(2);
    draws[0]!.dispose();
    expect(() => render([draws[0]!])).toThrowError(expect.objectContaining({ code: "VGPU-DRAW-DISPOSED" }));
    expect(() => draws[0]!.draw(out)).toThrowError(expect.objectContaining({ code: "VGPU-DRAW-DISPOSED" }));
    expect(() => render([draws[1]!])).not.toThrow();
    gpu.dispose();
    expect(() => draws[1]!.draw(out)).toThrowError(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  });
});
