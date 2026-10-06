import { describe, expect, test, vi } from "vitest";
import { bundle, compute, draw, effect, frame, init, storage, target, uniforms, type Frame } from "../../src/node.ts";

type Gpu = Awaited<ReturnType<typeof init>>;
type Target = ReturnType<typeof target>;

const WIDTH = 600;
const SHADER = `struct Camera { green: f32 }
struct Params { red: f32, blue: f32, index: f32 }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let c = corners[v];
  return vec4f((params.index + c.x) / ${WIDTH}.0 * 2.0 - 1.0, c.y * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(params.red, camera.green, params.blue, 1.0); }`;
const PAGE_LABEL = "vgpu.frame.uniforms";

/** Exact 8-bit channel values: k / 255 stores k in rgba8unorm. */
const red = (index: number, frameIndex: number) => (index * 7 + frameIndex * 31) % 256;
const green = (frameIndex: number) => (frameIndex * 13 + 5) % 256;
const blue = (frameIndex: number) => (frameIndex * 29 + 11) % 256;

/** One draw per pixel column: draw i writes pixel i with the frame's values. */
async function pixelScene(gpu: Gpu, count = WIDTH) {
  const camera = uniforms(gpu, { green: 0 });
  const draws = Array.from({ length: count }, (_, index) => draw(gpu, { shader: SHADER, vertices: 6, set: { camera, params: { red: 0, blue: 0, index } } }));
  const surface = () => target(gpu, { size: [WIDTH, 1], format: "rgba8unorm" });
  const output = surface();
  await draws[0]!.compile(output);
  const encode = (f: Frame, into: Target, frameIndex: number, order = draws.map((_, index) => index), value = red) => {
    camera.set({ green: green(frameIndex) / 255 });
    f.pass(into, p => {
      for (const index of order) {
        draws[index]!.set({ params: { red: value(index, frameIndex) / 255, blue: blue(frameIndex) / 255, index } });
        p.draw(draws[index]!);
      }
    });
  };
  return { draws, output, surface, encode };
}

async function expectPixels(into: Target, frameIndex: number, order: readonly number[], value = red) {
  const pixels = await into.color.read({ mipLevel: 0, region: "all" });
  for (const index of order) {
    const at = index * 4;
    expect([pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]], `pixel ${index} of frame ${frameIndex}`).toEqual([value(index, frameIndex), green(frameIndex), blue(frameIndex), 255]);
  }
}

function countNative(gpu: Gpu) {
  const bindGroups = vi.spyOn(gpu.gpu, "createBindGroup");
  const buffers = vi.spyOn(gpu.gpu, "createBuffer");
  return {
    bindGroups: () => bindGroups.mock.calls.length,
    pages: () => buffers.mock.calls.filter(([desc]) => desc.label === PAGE_LABEL).length,
    restore() { bindGroups.mockRestore(); buffers.mockRestore(); },
  };
}

const all = (count = WIDTH) => [...Array(count).keys()];

const native = process.env.VGPU_DOCKER_TEST === "1" || process.env.VGPU_NATIVE_COMPUTE_TEST === "1";
describe.skipIf(!native)("native managed uniform reuse", () => {
  test("repeated frames read their own values and stop creating bind groups after warmup", async () => {
    const gpu = await init();
    const counts = countNative(gpu);
    try {
      const { encode, output } = await pixelScene(gpu);
      for (let i = 0; i < 2; i++) await frame(gpu, f => encode(f, output, i)).done;
      const bindGroups = counts.bindGroups();
      const pages = counts.pages();
      for (let i = 2; i < 6; i++) {
        await frame(gpu, f => encode(f, output, i)).done;
        await expectPixels(output, i, all());
      }
      expect(counts.bindGroups()).toBe(bindGroups);
      expect(counts.pages()).toBe(pages);
    } finally { counts.restore(); gpu.dispose(); }
  });

  test("frames in flight keep separate snapshots and pages are recycled only after completion", async () => {
    const gpu = await init();
    const counts = countNative(gpu);
    try {
      const { encode, surface } = await pixelScene(gpu);
      const outputs = [surface(), surface(), surface()];
      let pages = 0;
      for (let cycle = 0; cycle < 4; cycle++) {
        const frames = outputs.map((into, slot) => frame(gpu, f => encode(f, into, cycle * 3 + slot)));
        await Promise.all(frames.map(f => f.done));
        for (const [slot, into] of outputs.entries()) await expectPixels(into, cycle * 3 + slot, all());
        if (cycle === 0) pages = counts.pages();
      }
      expect(counts.pages()).toBe(pages);
    } finally { counts.restore(); gpu.dispose(); }
  });

  test("equal sets keep bind groups and one changed draw changes only its pixel", async () => {
    const gpu = await init();
    const counts = countNative(gpu);
    try {
      const { encode, output } = await pixelScene(gpu);
      for (let i = 0; i < 2; i++) await frame(gpu, f => encode(f, output, 0)).done;
      const bindGroups = counts.bindGroups();
      for (let i = 0; i < 3; i++) {
        await frame(gpu, f => encode(f, output, 0)).done;
        await expectPixels(output, 0, all());
      }
      expect(counts.bindGroups()).toBe(bindGroups);
      const changed = (index: number, frameIndex: number) => index === 123 ? 250 : red(index, frameIndex);
      await frame(gpu, f => encode(f, output, 0, all(), changed)).done;
      await expectPixels(output, 0, all(), changed);
    } finally { counts.restore(); gpu.dispose(); }
  });

  test("passes and out-of-order manual frames keep their snapshots across equal sets", async () => {
    const gpu = await init();
    try {
      const fx = effect(gpu, `struct Params { value: f32 } @group(0) @binding(0) var<uniform> params: Params;
        @fragment fn main() -> @location(0) vec4f { return vec4f(params.value / 255.0, 0, 0, 1); }`, { set: { params: { value: 0 } } });
      const set = (value: number) => fx.set({ params: { value } });
      const outputs = [0, 1, 2].map(() => target(gpu, { size: [1, 1], format: "rgba8unorm" }));
      const value = async (into: Target) => (await into.color.read({ mipLevel: 0, region: "all" }))[0];
      await fx.compile(outputs[0]!);
      await frame(gpu, f => {
        set(10); f.pass(outputs[0]!, fx);
        set(20); set(20); f.pass(outputs[1]!, fx);
        set(10); f.pass(outputs[2]!, fx);
      }).done;
      expect(await Promise.all(outputs.map(value))).toEqual([10, 20, 10]);

      const a = frame(gpu);
      set(30); a.pass(outputs[0]!, fx);
      const b = frame(gpu);
      set(30); set(40); b.pass(outputs[1]!, fx);
      b.submit();
      a.submit();
      await Promise.all([a.done, b.done]);
      expect(await Promise.all(outputs.slice(0, 2).map(value))).toEqual([30, 40]);
    } finally { gpu.dispose(); }
  });

  test("rotated and culled draw orders render correctly", async () => {
    const gpu = await init();
    try {
      const { encode, output } = await pixelScene(gpu);
      for (let i = 0; i < 6; i++) {
        const order = all().map(index => (index + i * 97) % WIDTH).filter(index => (index + i) % 10 !== 0);
        await frame(gpu, f => encode(f, output, i, order)).done;
        await expectPixels(output, i, order);
      }
    } finally { gpu.dispose(); }
  });

  test("a recorded bundle stays live across equal and changed sets beside a captured draw", async () => {
    const gpu = await init();
    try {
      const fx = effect(gpu, `struct Params { value: f32 } @group(0) @binding(0) var<uniform> params: Params;
        @fragment fn main() -> @location(0) vec4f { return vec4f(params.value / 255.0, 0, 0, 1); }`, { set: { params: { value: 0 } } });
      const set = (value: number) => fx.set({ params: { value } });
      const live = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const captured = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const value = async (into: Target) => (await into.color.read({ mipLevel: 0, region: "all" }))[0];
      await fx.compile(live);
      set(70);
      const recorded = bundle(gpu, { target: live }, p => p.draw(fx));
      set(70);
      await frame(gpu, f => f.pass(live, p => p.bundles(recorded))).done;
      expect(await value(live)).toBe(70);
      await frame(gpu, f => {
        set(50); f.pass(captured, fx);
        set(60); f.pass(live, p => p.bundles(recorded));
      }).done;
      expect(await Promise.all([value(captured), value(live)])).toEqual([50, 60]);
    } finally { gpu.dispose(); }
  });

  test("a raw buffer range binds its offset and stays live", async () => {
    const gpu = await init();
    const counts = countNative(gpu);
    try {
      const fx = effect(gpu, `struct Params { color: vec4f } @group(0) @binding(0) var<uniform> params: Params;
        @fragment fn main() -> @location(0) vec4f { return params.color; }`);
      const buffer = gpu.gpu.createBuffer({ size: 512, usage: 0x40 | 0x08 });
      gpu.gpu.queue.writeBuffer(buffer, 0, new Float32Array([10 / 255, 0, 0, 1]));
      gpu.gpu.queue.writeBuffer(buffer, 256, new Float32Array([0, 20 / 255, 0, 1]));
      const output = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const pixel = async () => [...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 2)];
      fx.set({ params: { buffer, offset: 0, size: 16 } });
      await fx.compile(output);
      const before = counts.bindGroups();
      fx.draw(output);
      expect(await pixel()).toEqual([10, 0]);
      fx.set({ params: { buffer, offset: 256, size: 16 } });
      fx.draw(output);
      expect(await pixel()).toEqual([0, 20]);
      fx.set({ params: { buffer, offset: 0, size: 16 } });
      fx.draw(output);
      expect(await pixel()).toEqual([10, 0]);
      expect(counts.bindGroups() - before).toBe(2);
      gpu.gpu.queue.writeBuffer(buffer, 0, new Float32Array([30 / 255, 0, 0, 1]));
      fx.draw(output);
      expect(await pixel()).toEqual([30, 0]);
      buffer.destroy();
    } finally { counts.restore(); gpu.dispose(); }
  });

  test("an equal set still restores shared storage changed by the GPU", async () => {
    const gpu = await init();
    try {
      const state = uniforms(gpu, { v: 1 });
      const out = storage(gpu, 4);
      const writer = compute(gpu, "struct S { v: f32 } @group(0) @binding(0) var<storage, read_write> s: S; @compute @workgroup_size(1) fn main() { s.v = 10.0; }", { set: { s: state } });
      const reader = compute(gpu, `struct S { v: f32 } @group(0) @binding(0) var<storage, read> s: S;
        @group(0) @binding(1) var<storage, read_write> out: array<f32>;
        @compute @workgroup_size(1) fn main() { out[0] = s.v; }`, { set: { s: state, out } });
      writer.dispatch(1);
      reader.dispatch(1);
      expect(new Float32Array(await out.read())[0]).toBe(10);
      state.set({ v: 1 });
      reader.dispatch(1);
      expect(new Float32Array(await out.read())[0]).toBe(1);
    } finally { gpu.dispose(); }
  });

  test("disposing with a frame in flight leaves later gpus unaffected", async () => {
    const gpu = await init();
    const { encode, output } = await pixelScene(gpu);
    await frame(gpu, f => encode(f, output, 0)).done;
    const inFlight = frame(gpu, f => encode(f, output, 1));
    gpu.dispose();
    await expect(inFlight.done).resolves.toBeUndefined();

    const next = await init();
    try {
      const scene = await pixelScene(next);
      for (let i = 0; i < 2; i++) {
        await frame(next, f => scene.encode(f, scene.output, i + 2)).done;
        await expectPixels(scene.output, i + 2, all());
      }
    } finally { next.dispose(); }
  });
});
