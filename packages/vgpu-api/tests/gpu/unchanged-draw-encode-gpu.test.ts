import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test, vi } from "vitest";
import { draw, effect, frame, init, target, type Buffer } from "../../src/node.ts";

type Gpu = Awaited<ReturnType<typeof init>>;
type Target = ReturnType<typeof target>;

const WIDTH = 8;
// Three identity-bound uniform buffers like the issue #489 workload: group 0 and 2 shared, group 1 per draw.
const SHADER = `@group(0) @binding(0) var<uniform> scene: vec4f;
@group(1) @binding(0) var<uniform> own: vec4f;
@group(2) @binding(0) var<uniform> material: vec4f;
@vertex fn vs_main(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let c = corners[v];
  return vec4f((own.y + c.x) / ${WIDTH}.0 * 2.0 - 1.0, c.y * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(own.x, scene.y, material.z, 1.0); }`;
const COPY = `@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }`;
const FILL = `@group(0) @binding(0) var<uniform> color: vec4f;
@fragment fn main() -> @location(0) vec4f { return color; }`;

/** Exact 8-bit channel values: k / 255 stores k in rgba8unorm. */
const red = (index: number) => 10 + index * 20;

function scene(gpu: Gpu) {
  const uniform = (values: readonly number[]) => {
    const buffer = gpu.device.createBuffer({ size: 16, usage: ["uniform", "copy_dst"] });
    buffer.write(new Float32Array(values));
    return buffer;
  };
  const shared = uniform([0, 40 / 255, 0, 0]);
  const material = uniform([0, 0, 90 / 255, 0]);
  const own = Array.from({ length: WIDTH }, (_, index) => uniform([red(index) / 255, index, 0, 0]));
  const shader = prepareShader(SHADER);
  const draws = own.map((buffer) => draw(gpu, { shader, vertices: 6, set: { scene: shared, own: buffer, material } }));
  const output = target(gpu, { size: [WIDTH, 1], format: "rgba8unorm", depth: true });
  const render = () => frame(gpu, (f) => f.pass(output, (p) => { for (const item of draws) p.draw(item); })).done;
  return { uniform, shared, material, own, draws, output, render };
}

async function pixels(into: Target): Promise<number[][]> {
  const bytes = await into.color.read({ mipLevel: 0, region: "all" });
  return Array.from({ length: WIDTH }, (_, index) => [...bytes.subarray(index * 4, index * 4 + 4)]);
}

const expected = (green = 40, blue = 90, redOf = red) => Array.from({ length: WIDTH }, (_, index) => [redOf(index), green, blue, 255]);

const native = process.env.VGPU_DOCKER_TEST === "1" || process.env.VGPU_NATIVE_COMPUTE_TEST === "1";
describe.skipIf(!native)("native unchanged identity-bound draws", () => {
  test("unchanged frames render the bound buffers, see their writes, and stop creating bind groups", async () => {
    const gpu = await init();
    try {
      const { shared, material, output, render } = scene(gpu);
      await render();
      await render();
      const bindGroups = vi.spyOn(gpu.gpu, "createBindGroup");
      for (let index = 0; index < 5; index++) {
        await render();
        expect(await pixels(output), `unchanged frame ${index}`).toEqual(expected());
      }
      shared.write(new Float32Array([0, 120 / 255, 0, 0]));
      material.write(new Float32Array([0, 0, 200 / 255, 0]));
      await render();
      expect(await pixels(output)).toEqual(expected(120, 200));
      expect(bindGroups).not.toHaveBeenCalled();
    } finally { gpu.dispose(); }
  });

  test("set(), destruction and replacement after warm-up change exactly what the GPU reads", async () => {
    const gpu = await init();
    try {
      const { uniform, own, draws, output, render } = scene(gpu);
      for (let index = 0; index < 3; index++) await render();
      draws[2]!.set({ own: uniform([250 / 255, 2, 0, 0]) });
      await render();
      expect(await pixels(output)).toEqual(expected(40, 90, (index) => index === 2 ? 250 : red(index)));
      own[5]!.destroy();
      expect(() => frame(gpu, (f) => f.pass(output, (p) => { for (const item of draws) p.draw(item); }))).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
      draws[5]!.set({ own: uniform([5 / 255, 5, 0, 0]) });
      await render();
      expect(await pixels(output)).toEqual(expected(40, 90, (index) => index === 2 ? 250 : index === 5 ? 5 : red(index)));
      await render();
      expect(await pixels(output)).toEqual(expected(40, 90, (index) => index === 2 ? 250 : index === 5 ? 5 : red(index)));
    } finally { gpu.dispose(); }
  });

  test("a followed Target keeps sampling its newest attachment across resizes after warm-up", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [2, 2], format: "rgba8unorm" });
      const output = target(gpu, { size: [WIDTH, 1], format: "rgba8unorm" });
      const colorBuffer = (values: readonly number[]): Buffer => {
        const buffer = gpu.device.createBuffer({ size: 16, usage: ["uniform", "copy_dst"] });
        buffer.write(new Float32Array(values.map((value) => value / 255)));
        return buffer;
      };
      const fill = effect(gpu, prepareShader(FILL), { set: { color: colorBuffer([30, 60, 90, 255]) } });
      const copy = effect(gpu, prepareShader(COPY), { set: { source } });
      const render = () => frame(gpu, (f) => { f.pass(source, (p) => p.draw(fill)); f.pass(output, (p) => p.draw(copy)); }).done;
      for (let index = 0; index < 3; index++) await render();
      expect((await pixels(output))[0]).toEqual([30, 60, 90, 255]);
      source.resize([4, 4]);
      fill.set({ color: colorBuffer([200, 100, 50, 255]) });
      await render();
      expect((await pixels(output))[3]).toEqual([200, 100, 50, 255]);
      await render();
      expect((await pixels(output))[7]).toEqual([200, 100, 50, 255]);
    } finally { gpu.dispose(); }
  });
});
