import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, compute, draw, target } from "../src/mock.ts";

const OVERRIDE_WGSL = `
override SCALE: f32 = 1.0;
@id(7) override SAMPLES: u32 = 1u;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi] * SCALE, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(f32(SAMPLES)); }
`;

const FRAGMENT_ONLY_WGSL = `
override SHADE: f32 = 0.5;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(SHADE); }
`;

const BOOL_WGSL = `
override USE_LIGHT: bool = true;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(select(0.2, 1.0, USE_LIGHT)); }
`;

const NO_DEFAULT_WGSL = `
override gain: f32;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(gain); }
`;

const COMPUTE_WGSL = `
override STEP: f32 = 1.0;
@id(3) override LIMIT: u32 = 8u;
@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(1) fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < LIMIT) { data[id.x] = data[id.x] + STEP; }
}
`;

const COMPUTE_NO_DEFAULT_WGSL = `
override seed: u32;
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(1) fn cs_main(@builtin(global_invocation_id) id: vec3u) { data[id.x] = seed; }
`;

test("constants reach both render stages; @id overrides are keyed by the decimal id string", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: OVERRIDE_WGSL, label: "consts", constants: { SCALE: 2, "7": 4 } }).draw(colorTarget);

  // WebGPU keys constants module-level ("The pipeline-overridable constant is not required to be statically
  // used by entryPoint"), so the full record is valid for — and passed to — both stages.
  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.vertex.constants).toEqual({ SCALE: 2, "7": 4 });
  expect(desc?.fragment?.constants).toEqual({ SCALE: 2, "7": 4 });
  gpu.dispose();
});

test("an override used only by the fragment entry point is still valid for both stages", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: FRAGMENT_ONLY_WGSL, label: "frag-only", constants: { SHADE: 0.25 } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.vertex.constants).toEqual({ SHADE: 0.25 });
  expect(desc?.fragment?.constants).toEqual({ SHADE: 0.25 });
  gpu.dispose();
});

test("boolean values are allowed and convert to 1/0 doubles", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: BOOL_WGSL, label: "bool-consts", constants: { USE_LIGHT: false } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.vertex.constants).toEqual({ USE_LIGHT: 0 });
  expect(desc?.fragment?.constants).toEqual({ USE_LIGHT: 0 });
  gpu.dispose();
});

test("absent constants and an empty record keep descriptors byte-identical", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: OVERRIDE_WGSL, label: "absent" }).draw(colorTarget);
  draw(gpu, { shader: OVERRIDE_WGSL, label: "empty", constants: {} }).draw(colorTarget);

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors;
  expect(descs.at(-1)?.vertex.constants).toBeUndefined();
  expect(descs.at(-1)?.fragment?.constants).toBeUndefined();
  expect("constants" in (descs.at(-1)?.vertex ?? {})).toBe(false);
  gpu.dispose();
});

test("unknown constants keys fail at construction listing the available overrides", async () => {
  const gpu = await init();
  expect(() => draw(gpu, { shader: OVERRIDE_WGSL, label: "unknown", constants: { NOPE: 1 } })).toThrowError(/VGPU-CONSTANTS-INVALID|"SCALE", "7" \(@id of SAMPLES\)/);
  // An @id override is identified only by the decimal id string, never by its name.
  expect(() => draw(gpu, { shader: OVERRIDE_WGSL, label: "id-by-name", constants: { SAMPLES: 4 } })).toThrowError(/VGPU-CONSTANTS-INVALID|available overrides/);
  expect(() => draw(gpu, { shader: FRAGMENT_ONLY_WGSL, label: "not-object", constants: [1] as never })).toThrowError(/VGPU-CONSTANTS-INVALID|expected \{ overrideNameOrId/);
  gpu.dispose();
});

test("non-finite values fail at construction; strings are rejected", async () => {
  const gpu = await init();
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "2"]) {
    expect(() => draw(gpu, { shader: FRAGMENT_ONLY_WGSL, label: "bad-value", constants: { SHADE: value } as never })).toThrowError(/VGPU-CONSTANTS-INVALID|finite number or a boolean/);
  }
  gpu.dispose();
});

test("an override without a default must be provided", async () => {
  const gpu = await init();
  expect(() => draw(gpu, { shader: NO_DEFAULT_WGSL, label: "missing" })).toThrowError(/VGPU-CONSTANTS-INVALID|override 'gain' has no default value/);
  expect(() => draw(gpu, { shader: NO_DEFAULT_WGSL, label: "still-missing", constants: {} })).toThrowError(/VGPU-CONSTANTS-INVALID|override 'gain' has no default value/);
  expect(() => draw(gpu, { shader: NO_DEFAULT_WGSL, label: "provided", constants: { gain: 0.5 } })).not.toThrow();
  gpu.dispose();
});

test("compute constants reach the compute stage; @id keys and omission behave like draws", async () => {
  const gpu = await init();

  compute(gpu, COMPUTE_WGSL, { label: "sim", constants: { STEP: 0.5, "3": 4 } });
  compute(gpu, COMPUTE_WGSL, { label: "sim-absent" });

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createComputePipelineDescriptors;
  expect(descs.at(-2)?.compute.constants).toEqual({ STEP: 0.5, "3": 4 });
  expect(descs.at(-1)?.compute.constants).toBeUndefined();
  expect("constants" in (descs.at(-1)?.compute ?? {})).toBe(false);
  gpu.dispose();
});

test("compute constants validate at construction with where compute", async () => {
  const gpu = await init();
  expect(() => compute(gpu, COMPUTE_WGSL, { label: "unknown", constants: { LIMIT: 4 } })).toThrowError(/VGPU-CONSTANTS-INVALID|"STEP", "3" \(@id of LIMIT\)/);
  expect(() => compute(gpu, COMPUTE_WGSL, { label: "nan", constants: { STEP: Number.NaN } })).toThrowError(/VGPU-CONSTANTS-INVALID|finite number or a boolean/);
  expect(() => compute(gpu, COMPUTE_NO_DEFAULT_WGSL, { label: "missing" })).toThrowError(/VGPU-CONSTANTS-INVALID|override 'seed' has no default value/);
  expect(() => compute(gpu, COMPUTE_NO_DEFAULT_WGSL, { label: "provided", constants: { seed: 1 } })).not.toThrow();
  gpu.dispose();
});
