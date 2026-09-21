import { describe, expect, test } from "vitest";
import { compute, draw, effect, frame, init, storage, target } from "../../src/node.ts";

const native = process.env.VGPU_DOCKER_TEST === "1" || process.env.VGPU_NATIVE_ENTRY_TEST === "1";
const customFragment = "@fragment fn custom_color() -> @location(0) vec4f { return vec4f(0, 0, 1, 1); }";
const mainFragment = "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 1, 0, 1); }";
const alternateFragment = "@fragment fn alternate_color() -> @location(0) vec4f { return vec4f(1); }";

describe.skipIf(!native)("native stage entry selection", () => {
  test("effect pixels reflect defaults, explicit selection, unique names and source-order fallback", async () => {
    const gpu = await init();
    try {
      const cases = [
        { source: `${customFragment}\n${mainFragment}`, expected: [255, 255, 0, 255] },
        { source: `${mainFragment}\n${customFragment}`, expected: [255, 255, 0, 255] },
        { source: `${customFragment}\n${mainFragment}`, entry: { fragment: "custom_color" }, expected: [0, 0, 255, 255] },
        { source: customFragment, expected: [0, 0, 255, 255] },
        { source: `${customFragment}\n${alternateFragment}`, expected: [0, 0, 255, 255] },
      ];
      for (const { source, entry, expected } of cases) {
        const output = target(gpu, { size: [2, 2], format: "rgba8unorm" });
        const fx = effect(gpu, source, { entry });
        await fx.compile(output);
        await frame(gpu, f => f.pass(output, fx)).done;
        expect([...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual(expected);
      }
    } finally { gpu.dispose(); }
  });

  test("draw selects vertex coverage independently from the fragment override", async () => {
    const gpu = await init();
    try {
      const shader = `
        @vertex fn offscreen() -> @builtin(position) vec4f { return vec4f(2, 2, 0, 1); }
        @vertex fn vs_main(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
          let x = f32(id & 1u) * 4.0 - 1.0;
          let y = f32(id >> 1u) * 4.0 - 1.0;
          return vec4f(x, y, 0, 1);
        }
        ${customFragment}
        ${mainFragment}`;
      for (const [entry, expected] of [
        [undefined, [255, 255, 0, 255]],
        [{ fragment: "custom_color" }, [0, 0, 255, 255]],
        [{ vertex: "offscreen" }, [0, 0, 0, 0]],
      ] as const) {
        const output = target(gpu, { size: [2, 2], format: "rgba8unorm" });
        const render = draw(gpu, { shader, entry });
        await render.compile(output);
        await frame(gpu, f => f.pass({ target: output, clear: [0, 0, 0, 0] }, render)).done;
        expect([...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual(expected);
      }
    } finally { gpu.dispose(); }
  });

  test("compute readback follows entry selection in standalone and frame dispatches", async () => {
    const gpu = await init();
    try {
      const binding = "@group(0) @binding(0) var<storage, read_write> output: array<u32>;";
      const custom = "@compute @workgroup_size(1) fn custom_kernel() { output[0] = 17; }";
      const main = "@compute @workgroup_size(1) fn cs_main() { output[0] = 42; }";
      const alternate = "@compute @workgroup_size(1) fn alternate_kernel() { output[0] = 99; }";
      for (const { entries, entry, expected } of [
        { entries: `${custom}\n${main}`, expected: 42 },
        { entries: `${main}\n${custom}`, expected: 42 },
        { entries: `${custom}\n${main}`, entry: "custom_kernel", expected: 17 },
        { entries: custom, expected: 17 },
        { entries: `${custom}\n${alternate}`, expected: 17 },
      ]) {
        const output = storage(gpu, 4);
        const kernel = compute(gpu, `${binding}\n${entries}`, { entry, set: { output } });
        await kernel.compile();
        kernel.dispatch(1);
        await gpu.settled();
        expect(new Uint32Array(await output.read())[0]).toBe(expected);
        output.write(new Uint32Array([0]));
        await frame(gpu, f => f.computePass(p => p.dispatch(kernel, 1))).done;
        expect(new Uint32Array(await output.read())[0]).toBe(expected);
      }
    } finally { gpu.dispose(); }
  });
});
