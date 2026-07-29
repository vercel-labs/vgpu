import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, draw, target } from "../src/mock.ts";

const MRT_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
struct Out { @location(0) a: vec4f, @location(1) b: vec4f }
@fragment fn fs_main() -> Out {
  var out: Out;
  out.a = vec4f(1.0, 0.0, 0.0, 1.0);
  out.b = vec4f(0.0, 1.0, 0.0, 1.0);
  return out;
}
`;

const ALPHA_BLEND = { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } as const;
const ADDITIVE_BLEND = { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } as const;

test("per-color-target blend and writeMask reach each render pipeline target by index", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], colors: [{ format: "rgba8unorm" }, { format: "rgba16float" }] });

  draw(gpu, {
    shader: MRT_SHADER,
    label: "mrt",
    colors: [
      { blend: "alpha", writeMask: ["r", "g"] },
      { blend: { color: { src: "one", dst: "one" } }, writeMask: ["a"] },
    ],
  }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.fragment?.targets).toEqual([
    { format: "rgba8unorm", blend: ALPHA_BLEND, writeMask: 3 },
    { format: "rgba16float", blend: ADDITIVE_BLEND, writeMask: 8 },
  ]);
  gpu.dispose();
});

test("null, missing, and empty entries inherit the top-level blend and writeMask per field", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], colors: [{ format: "rgba8unorm" }, { format: "rgba8unorm" }, { format: "rgba8unorm" }] });

  draw(gpu, {
    shader: MRT_SHADER,
    label: "inherit",
    blend: "alpha",
    writeMask: ["r", "g", "b"],
    colors: [null, {}, { blend: "additive" }],
  }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  // Entries override per field: colors[2] pins blend but still inherits the top-level writeMask.
  expect(desc?.fragment?.targets).toEqual([
    { format: "rgba8unorm", blend: ALPHA_BLEND, writeMask: 7 },
    { format: "rgba8unorm", blend: ALPHA_BLEND, writeMask: 7 },
    { format: "rgba8unorm", blend: ADDITIVE_BLEND, writeMask: 7 },
  ]);
  gpu.dispose();
});

test("absent colors keeps the uniform top-level state on every attachment", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], colors: [{ format: "rgba8unorm" }, { format: "rgba16float" }] });

  draw(gpu, { shader: MRT_SHADER, label: "uniform", blend: "additive", writeMask: ["r"] }).draw(colorTarget);
  draw(gpu, { shader: MRT_SHADER, label: "plain" }).draw(colorTarget);

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors;
  expect(descs.at(-2)?.fragment?.targets).toEqual([
    { format: "rgba8unorm", blend: ADDITIVE_BLEND, writeMask: 1 },
    { format: "rgba16float", blend: ADDITIVE_BLEND, writeMask: 1 },
  ]);
  expect(descs.at(-1)?.fragment?.targets).toEqual([{ format: "rgba8unorm" }, { format: "rgba16float" }]);
  gpu.dispose();
});

test("writeMask [] silences one attachment without touching its siblings", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], colors: [{ format: "rgba8unorm" }, { format: "rgba8unorm" }] });

  draw(gpu, { shader: MRT_SHADER, label: "silence", colors: [null, { writeMask: [] }] }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.fragment?.targets).toEqual([
    { format: "rgba8unorm" },
    { format: "rgba8unorm", writeMask: 0 },
  ]);
  gpu.dispose();
});

test("colors length must match the target signature's color attachment count", async () => {
  const gpu = await init();
  const single = target(gpu, { size: [2, 2] });
  const mrt = target(gpu, { size: [2, 2], colors: [{ format: "rgba8unorm" }, { format: "rgba8unorm" }] });
  const drawable = draw(gpu, { shader: MRT_SHADER, label: "mismatch", colors: [{ writeMask: [] }] });

  expect(() => drawable.draw(mrt)).toThrowError(/VGPU-COLORS-INVALID|colors has 1, but the target signature has 2/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm", "rgba8unorm", "rgba8unorm"] })).toThrowError(/colors has 1, but the target signature has 3/);
  expect(() => drawable.draw(single)).not.toThrow();
  // targets: [...] compiles at construction, so the mismatch surfaces from draw itself.
  expect(() => draw(gpu, { shader: MRT_SHADER, label: "eager-mismatch", targets: [mrt], colors: [null] })).toThrowError(/VGPU-COLORS-INVALID|colors has 1, but the target signature has 2/);
  gpu.dispose();
});

test("invalid colors options fail at draw construction", async () => {
  const gpu = await init();
  expect(() => draw(gpu, { shader: MRT_SHADER, label: "not-array", colors: "rgba" as never })).toThrowError(/VGPU-COLORS-INVALID|must be an array/);
  expect(() => draw(gpu, { shader: MRT_SHADER, label: "bad-entry", colors: [42] as never })).toThrowError(/VGPU-COLORS-INVALID|colors\[0\]/);
  expect(() => draw(gpu, { shader: MRT_SHADER, label: "array-entry", colors: [["r"]] as never })).toThrowError(/VGPU-COLORS-INVALID|colors\[0\]/);
  expect(() => draw(gpu, { shader: MRT_SHADER, label: "bad-blend", colors: [{ blend: "screen" }] as never })).toThrowError(/VGPU-BLEND-INVALID|Invalid blend/);
  expect(() => draw(gpu, { shader: MRT_SHADER, label: "bad-mask", colors: [{ writeMask: ["x"] }] as never })).toThrowError(/VGPU-WRITEMASK-INVALID|Invalid writeMask/);
  gpu.dispose();
});

test("colors participate in shared pipeline cache keys", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], colors: [{ format: "rgba8unorm" }, { format: "rgba8unorm" }] });
  const a = draw(gpu, { shader: MRT_SHADER, label: "colors-a", blend: "alpha", colors: [null, { writeMask: [] }] });
  const b = draw(gpu, { shader: MRT_SHADER, label: "colors-b", blend: "alpha", colors: [{ writeMask: [] }, null] });
  const c = draw(gpu, { shader: MRT_SHADER, label: "colors-c", blend: "alpha", colors: [null, { writeMask: [] }] });
  const uniform = draw(gpu, { shader: MRT_SHADER, label: "colors-none", blend: "alpha" });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);
  uniform.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(3);
  gpu.dispose();
});
