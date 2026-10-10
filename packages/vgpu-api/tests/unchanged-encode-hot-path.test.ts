import { prepareShader } from "@vgpu/wgsl/prepare";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ComputePipeline } from "../src/compute.ts";
import { effectDraw } from "../src/effect.ts";
import { drawEncodeTestState, type InternalDraw } from "../src/draw.ts";
import { compute, draw, effect, frame, init, surface, target, uniforms, type Draw, type Target } from "../src/mock.ts";
import { THREE_GROUPS, ZERO_WORK, delta, hotPathCounters, issueWorkload, recordBindings, uniformBuffer } from "./fixtures/unchanged-encode.ts";

const SAMPLE = `@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(src, vec2i(0), 0); }`;
const STORAGE = `@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(1) fn main() { values[0] += 1u; }`;

const FULLSCREEN = `@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`;

afterEach(() => vi.restoreAllMocks());

const derivations = (item: Draw) => drawEncodeTestState(item as InternalDraw).pipelineKeyDerivations;

// Structural gates for issue #489: once warm, encoding an unchanged identity-bound consumer does no
// lifetime maintenance, no binding verification scan, no bind group/pipeline key construction and
// creates no native object. Timing lives in scripts/bench-draw-encode.mjs, not here.
describe("unchanged identity-bound encode hot path", () => {
  test("H1: the issue workload encodes unchanged frames with zero per-draw work", async () => {
    const gpu = await init();
    try {
      const { draws, out } = issueWorkload(gpu, 4);
      const run = () => frame(gpu, (f) => { for (let pass = 0; pass < 3; pass++) f.pass({ target: out }, (p) => { for (const item of draws) p.draw(item); }); });
      run(); run();
      await gpu.settled();
      const before = hotPathCounters(gpu, draws);
      for (let index = 0; index < 10; index++) run();
      const { createCommandEncoder, ...work } = delta(before, hotPathCounters(gpu, draws));
      expect(work).toEqual(ZERO_WORK);
      expect(createCommandEncoder).toBe(10);
    } finally { gpu.dispose(); }
  });

  test("H2: a one-shot draw.draw(target) verifies its bindings at most once per change, not per internal preflight", async () => {
    const gpu = await init();
    try {
      const { draws: [item], out } = issueWorkload(gpu, 1);
      item!.draw(out);
      const before = hotPathCounters(gpu, [item!]);
      item!.draw(out);
      item!.draw(out);
      const { createCommandEncoder, ...work } = delta(before, hotPathCounters(gpu, [item!]));
      expect(work).toEqual(ZERO_WORK);
      expect(createCommandEncoder).toBe(2);
    } finally { gpu.dispose(); }
  });

  test("H3: unchanged compute dispatches skip verification and bind group construction", async () => {
    const gpu = await init();
    try {
      const values = gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst"], label: "values" });
      const sim = compute(gpu, prepareShader(STORAGE), { label: "sim", set: { values } });
      const core = (sim as ComputePipeline).setCore;
      sim.dispatch(1);
      const before = hotPathCounters(gpu, [], [core]);
      sim.dispatch(1);
      sim.dispatch(1);
      sim.dispatch(1);
      frame(gpu, (f) => f.computePass((p) => { p.dispatch(sim, 1); p.dispatch(sim, 1); }));
      const { createCommandEncoder, ...work } = delta(before, hotPathCounters(gpu, [], [core]));
      expect(work).toEqual(ZERO_WORK);
      expect(createCommandEncoder).toBe(4);
    } finally { gpu.dispose(); }
  });

  test("H4: dynamic uniform groups keep capturing each frame while the static group and verification stay cached", async () => {
    const gpu = await init();
    try {
      const recorded = recordBindings(gpu);
      const shared = uniforms(gpu, { color: [0, 0, 0, 1] });
      const out = target(gpu, { size: [4, 4] });
      const item = draw(gpu, { shader: prepareShader(THREE_GROUPS), label: "mixed", vertices: 3, set: { frame: uniformBuffer(gpu, 64), material: shared } });
      const world = (value: number) => ({ world: [value, ...Array.from({ length: 15 }, () => 0)] });
      const render = (value: number) => {
        item.set({ object: world(value) });
        shared.set({ color: [value * 10, 0, 0, 1] });
        frame(gpu, (f) => f.pass(out, (p) => p.draw(item)));
      };
      render(1);
      render(2);
      const before = hotPathCounters(gpu, [item]);
      for (let value = 3; value < 8; value++) {
        render(value);
        expect(recorded.lastFloat(1)).toBe(value);
        expect(recorded.lastFloat(2)).toBe(value * 10);
      }
      const work = delta(before, hotPathCounters(gpu, [item]));
      expect(work.fullVerifications).toBe(0);
      // Groups 1 (lib-owned value) and 2 (shared uniforms) are captured per encode; group 0 is not rebuilt.
      expect(work.groupPlanBuilds).toBe(5 * 2);
      expect(work.pipelineKeyDerivations).toBe(0);
    } finally { gpu.dispose(); }
  });

  test("H5: a followed Target keeps its identity check on hot hits; only a real resize rebuilds", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4] });
      const out = target(gpu, { size: [4, 4] });
      const followed = effect(gpu, prepareShader(SAMPLE), { label: "followed", set: { src: source } });
      const internal = effectDraw(followed);
      const render = () => frame(gpu, (f) => f.pass(out, (p) => p.draw(followed)));
      render();
      let before = hotPathCounters(gpu, [internal]);
      render(); render(); render();
      source.resize([4, 4]);
      render();
      const { createCommandEncoder, ...work } = delta(before, hotPathCounters(gpu, [internal]));
      expect(work).toEqual(ZERO_WORK);
      expect(createCommandEncoder).toBe(4);
      before = hotPathCounters(gpu, [internal]);
      source.resize([8, 8]);
      render();
      const resized = delta(before, hotPathCounters(gpu, [internal]));
      expect(resized.fullVerifications).toBeLessThanOrEqual(1);
      expect(resized.createBindGroup).toBe(1);
      before = hotPathCounters(gpu, [internal]);
      render(); render();
      const { createCommandEncoder: encoders, ...settled } = delta(before, hotPathCounters(gpu, [internal]));
      expect(settled).toEqual(ZERO_WORK);
      expect(encoders).toBe(2);
    } finally { gpu.dispose(); }
  });

  test("H6: the counters move when bindings and targets do change", async () => {
    const gpu = await init();
    try {
      const { draws: [item] } = issueWorkload(gpu, 1);
      frame(gpu, (f) => f.pass(target(gpu, { size: [8, 8], depth: true }), (p) => p.draw(item!)));
      const before = hotPathCounters(gpu, [item!]);
      for (let index = 0; index < 3; index++) {
        item!.set({ object: uniformBuffer(gpu, 64) });
        frame(gpu, (f) => f.pass(target(gpu, { size: [8, 8], depth: true, format: index % 2 ? "rgba8unorm" : "bgra8unorm" }), (p) => p.draw(item!)));
      }
      const work = delta(before, hotPathCounters(gpu, [item!]));
      expect(work.createBindGroup).toBe(3);
      expect(work.fullVerifications).toBeGreaterThanOrEqual(3);
      expect(work.groupPlanBuilds).toBeGreaterThanOrEqual(3);
      expect(work.bindingKeyBuilds).toBeGreaterThanOrEqual(3);
      expect(work.pipelineKeyDerivations).toBeGreaterThanOrEqual(3);
      expect(work.maintenanceVisits).toBeGreaterThan(0);
      expect(work.createRenderPipeline).toBe(1);
    } finally { gpu.dispose(); }
  });

  test("H7: pipeline keys derive once per target signature and layout, including Surface lookups", async () => {
    const gpu = await init();
    try {
      const { draws: [item], out } = issueWorkload(gpu, 1);
      const bgra = target(gpu, { size: [8, 8], depth: true, format: "bgra8unorm" });
      const render = (into: Target, opts = {}) => frame(gpu, (f) => f.pass({ target: into }, (p) => p.draw(item!, opts)));
      render(out);
      let before = derivations(item!);
      render(out); render(out);
      expect(derivations(item!)).toBe(before);
      render(bgra); render(bgra); render(out); render(bgra);
      expect(derivations(item!)).toBe(before + 1);
      item!.compileSync(out);
      expect(derivations(item!)).toBe(before + 1);
      before = derivations(item!);
      item!.layout(0, { dynamicOffsets: true });
      render(out, { offsets: { 0: [0] } });
      render(out, { offsets: { 0: [0] } });
      expect(derivations(item!)).toBe(before + 1);
      const canvas = { width: 6, height: 4, getContext: () => ({ configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => { throw new Error("acquired"); } }) } as unknown as OffscreenCanvas;
      const screen = surface(gpu, canvas, { autoResize: false, format: "rgba8unorm" });
      const onScreen = draw(gpu, { shader: prepareShader(FULLSCREEN), label: "onScreen" });
      onScreen.compileSync(screen);
      before = derivations(onScreen);
      onScreen.compileSync(screen);
      (onScreen as InternalDraw).pipelineFor(screen);
      expect(derivations(onScreen)).toBe(before);
    } finally { gpu.dispose(); }
  });

  test("H8: every invalidating transition costs one rebuild and then returns to zero work; rejected set() costs nothing", async () => {
    const gpu = await init();
    try {
      const { draws, objects, out, mesh, shader: workloadShader } = issueWorkload(gpu, 2);
      const [item] = draws;
      const render = () => frame(gpu, (f) => f.pass({ target: out }, (p) => { for (const each of draws) p.draw(each); }));
      const work = (body: () => void) => {
        const before = hotPathCounters(gpu, draws);
        body();
        const { createCommandEncoder: _, ...rest } = delta(before, hotPathCounters(gpu, draws));
        return rest;
      };
      const settlesToZero = () => { render(); expect(work(() => { render(); render(); })).toEqual(ZERO_WORK); };
      render(); render();
      expect(work(() => { item!.set({ object: objects[0]! }); render(); })).toMatchObject({ createBindGroup: 0, fullVerifications: 1, groupPlanBuilds: 3 });
      settlesToZero();
      const dead = uniformBuffer(gpu, 64);
      dead.destroy();
      expect(work(() => {
        expect(() => item!.set({ object: dead })).toThrow();
        expect(() => item!.set({ object: gpu.device.createBuffer({ size: 64, usage: ["storage"] }) })).toThrow();
        render();
      })).toEqual(ZERO_WORK);
      item!.set({ object: uniformBuffer(gpu, 64) });
      settlesToZero();
      item!.layout(1, { dynamicOffsets: true });
      settlesToZero();
      // Destroying any tracked resource (here one bound only by an uncounted draw) rescans each consumer once; plans survive.
      const spare = uniformBuffer(gpu, 64);
      const other = draw(gpu, { shader: workloadShader, geometry: mesh, label: "other", set: { frame: uniformBuffer(gpu, 64), object: spare, material: uniformBuffer(gpu, 16) } });
      frame(gpu, (f) => f.pass({ target: out }, (p) => p.draw(other)));
      spare.destroy();
      expect(work(render)).toMatchObject({ fullVerifications: 2, groupPlanBuilds: 0, createBindGroup: 0, bindingKeyBuilds: 0 });
      expect(work(render)).toEqual(ZERO_WORK);
      objects[1]!.destroy();
      expect(() => render()).toThrow();
      expect(() => render()).toThrow();
      draws[1]!.set({ object: uniformBuffer(gpu, 64) });
      settlesToZero();
    } finally { gpu.dispose(); }
  });
});
