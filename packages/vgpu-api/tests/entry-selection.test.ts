import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, compute, draw, geometry, target } from "../src/mock.ts";

const TWO_FRAGMENT_WGSL = `
@group(0) @binding(0) var<uniform> tintA: vec4f;
@group(0) @binding(1) var<uniform> tintB: vec4f;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_a() -> @location(0) vec4f { return tintA; }
@fragment fn fs_b() -> @location(0) vec4f { return tintB; }
`;

const TWO_VERTEX_WGSL = `
@vertex fn vs_plain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@vertex fn vs_mesh(@location(0) position: vec3f) -> @builtin(position) vec4f { return vec4f(position, 1.0); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const VERTEX_STORAGE_WGSL = `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@vertex fn vs_plain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@vertex fn vs_storage(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return positions[vi]; }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const TWO_COMPUTE_WGSL = `
@group(0) @binding(0) var<storage, read_write> a: array<u32>;
@group(0) @binding(1) var<storage, read_write> b: array<u32>;
@compute @workgroup_size(1) fn cs_a(@builtin(global_invocation_id) id: vec3u) { a[id.x] = 1u; }
@compute @workgroup_size(1) fn cs_b(@builtin(global_invocation_id) id: vec3u) { b[id.x] = 2u; }
`;

const MIXED_STAGE_COMPUTE_WGSL = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return vec4f(0.0); }
@compute @workgroup_size(1) fn cs_main() {}
`;

function layoutEntries(gpu: Awaited<ReturnType<typeof init>>, label: string): readonly GPUBindGroupLayoutEntry[] {
  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createBindGroupLayoutDescriptors.find((item) => item.label === `${label}.group0.bgl`);
  if (!desc) throw new Error(`missing ${label} layout`);
  return [...desc.entries];
}

test("entry selects the named fragment entry point in the pipeline descriptor", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "pick-b", entry: { fragment: "fs_b" }, set: { tintB: [1, 0, 0, 1] } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.vertex.entryPoint).toBe("vs_main");
  expect(desc?.fragment?.entryPoint).toBe("fs_b");
  gpu.dispose();
});

test("entry selects the named vertex entry point; its inputs feed the geometry layout resolver", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const geo = geometry(gpu, { buffers: [{ data: new Float32Array(9), attributes: { position: "float32x3" } }] });

  // The first vertex entry (vs_plain) has no inputs, so the geometry attribute would be unmatched with default selection.
  expect(() => draw(gpu, { shader: TWO_VERTEX_WGSL, label: "default-vertex", geometry: geo })).toThrow(expect.objectContaining({ code: "VGPU-MESH-ATTRIBUTE-UNMATCHED" }));

  draw(gpu, { shader: TWO_VERTEX_WGSL, label: "pick-geometry", entry: { vertex: "vs_mesh" }, geometry: geo }).draw(colorTarget);
  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.vertex.entryPoint).toBe("vs_mesh");
  expect(desc?.vertex.buffers).toEqual([{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }]);
  gpu.dispose();
});

test("binding visibility follows the selected fragment entry point", async () => {
  const gpu = await init();

  draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "vis-a" });
  // Default first-of-stage selection: only tintA (binding 0) is statically used, with fragment visibility.
  expect(layoutEntries(gpu, "vis-a").map(({ binding, visibility }) => [binding, visibility])).toEqual([[0, 2]]);

  draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "vis-b", entry: { fragment: "fs_b" } });
  // fs_b selected: only tintB (binding 1) gets fragment visibility; tintA drops out of the layout.
  expect(layoutEntries(gpu, "vis-b").map(({ binding, visibility }) => [binding, visibility])).toEqual([[1, 2]]);
  gpu.dispose();
});

test("storage-stage limits validate against the selected vertex entry point", async () => {
  const gpu = await init();
  Object.defineProperty(gpu.device.gpu, "limits", { value: { ...gpu.device.limits, maxStorageBuffersInVertexStage: 0, maxStorageBuffersInFragmentStage: 4 } });

  // The first vertex entry uses no storage, so the zero limit is fine by default.
  expect(() => draw(gpu, { shader: VERTEX_STORAGE_WGSL, label: "limit-default" })).not.toThrow();
  // Selecting the storage-using entry makes the same shader exceed the limit, reported for that entry.
  expect(() => draw(gpu, { shader: VERTEX_STORAGE_WGSL, label: "limit-storage", entry: { vertex: "vs_storage" } })).toThrow(expect.objectContaining({
    code: "VGPU-LIMIT-STORAGE-VERTEX",
    detail: expect.objectContaining({ entryPoint: "vs_storage", count: 1, limit: 0 }),
  }));
  gpu.dispose();
});

test("unknown and wrong-stage entry names fail at construction listing the available entry points", async () => {
  const gpu = await init();
  expect(() => draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "unknown", entry: { fragment: "fs_c" } })).toThrowError(/VGPU-ENTRY-INVALID|"vs_main" \(@vertex\), "fs_a" \(@fragment\), "fs_b" \(@fragment\)/);
  expect(() => draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "wrong-stage", entry: { vertex: "fs_a" } })).toThrowError(/VGPU-ENTRY-INVALID|is a @fragment entry point, not @vertex/);
  expect(() => draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "not-object", entry: "fs_b" as never })).toThrowError(/VGPU-ENTRY-INVALID|expected \{ vertex\?, fragment\? \}/);
  expect(() => draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "not-string", entry: { fragment: 2 as never } })).toThrowError(/VGPU-ENTRY-INVALID|expected an entry point name string/);
  gpu.dispose();
});

test("absent entry keeps descriptors byte-identical to first-of-stage selection", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: TWO_FRAGMENT_WGSL, label: "absent", set: { tintA: [0, 1, 0, 1] } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.vertex.entryPoint).toBe("vs_main");
  expect(desc?.fragment?.entryPoint).toBe("fs_a");
  gpu.dispose();
});

test("compute entry selects the named @compute entry point and its binding visibility", async () => {
  const gpu = await init();

  compute(gpu, TWO_COMPUTE_WGSL, { label: "pick-cs-b", entry: "cs_b" });
  compute(gpu, TWO_COMPUTE_WGSL, { label: "cs-default" });

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createComputePipelineDescriptors;
  expect(descs.at(-2)?.compute.entryPoint).toBe("cs_b");
  expect(descs.at(-1)?.compute.entryPoint).toBe("cs_a");
  // cs_b statically uses only b (binding 1); cs_a only a (binding 0).
  expect(layoutEntries(gpu, "pick-cs-b").map(({ binding, visibility }) => [binding, visibility])).toEqual([[1, 4]]);
  expect(layoutEntries(gpu, "cs-default").map(({ binding, visibility }) => [binding, visibility])).toEqual([[0, 4]]);
  gpu.dispose();
});

test("compute entry validates at construction with where compute", async () => {
  const gpu = await init();
  expect(() => compute(gpu, TWO_COMPUTE_WGSL, { label: "unknown", entry: "cs_c" })).toThrow(expect.objectContaining({ code: "VGPU-ENTRY-INVALID", where: "compute" }));
  expect(() => compute(gpu, TWO_COMPUTE_WGSL, { label: "unknown-list", entry: "cs_c" })).toThrowError(/"cs_a" \(@compute\), "cs_b" \(@compute\)/);
  expect(() => compute(gpu, MIXED_STAGE_COMPUTE_WGSL, { label: "wrong-stage", entry: "vs_main" })).toThrowError(/VGPU-ENTRY-INVALID|is a @vertex entry point, not @compute/);
  expect(() => compute(gpu, TWO_COMPUTE_WGSL, { label: "not-string", entry: 1 as never })).toThrowError(/VGPU-ENTRY-INVALID|expected an entry point name string/);
  gpu.dispose();
});
