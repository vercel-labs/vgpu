import { describe, expect, test } from "vitest";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { selectEntryPoint } from "../src/pipeline-store.ts";
import { compute, draw, effect, frame, geometry, getMockGPUDeviceInstrumentation, init, storage, target } from "../src/mock.ts";

const stages = ["vertex", "fragment", "compute"] as const;
const names = { vertex: "vs_main", fragment: "fs_main", compute: "cs_main" };
function declaration(stage: typeof stages[number], name: string): string {
  if (stage === "compute") return `@compute @workgroup_size(1) fn ${name}() {}`;
  return `@${stage} fn ${name}() -> ${stage === "vertex" ? "@builtin(position)" : "@location(0)"} vec4f { return vec4f(1); }`;
}

describe.each(stages)("%s entry resolution", stage => {
  test.each([
    ["custom"], ["custom", "alternate"], ["custom", names[stage]], [names[stage], "custom"],
  ])("resolves candidates %j", (...candidates: string[]) => {
    const entries = reflectSource(candidates.map(name => declaration(stage, name)).join("\n")).entryPoints;
    const expected = candidates.includes(names[stage]) ? names[stage] : candidates[0];
    expect(selectEntryPoint("test", entries, stage, undefined, "test")).toBe(entries.find(entry => entry.name === expected));
    expect(selectEntryPoint("test", entries, stage, "custom", "test")?.name).toBe("custom");
  });

  test("validates explicit selection even with a single matching entry", () => {
    const otherStage = stage === "compute" ? "fragment" : "compute";
    const entries = reflectSource(`${declaration(stage, "custom")}\n${declaration(otherStage, names[stage])}`).entryPoints;
    expect(selectEntryPoint("test", entries, stage, undefined, "test")?.name).toBe("custom");
    for (const invalid of ["missing", "", names[stage], null, 12]) {
      expect(() => selectEntryPoint("test", entries, stage, invalid as string, "test")).toThrow(expect.objectContaining({ code: "VGPU-ENTRY-INVALID" }));
    }
    expect(selectEntryPoint("test", [], stage, undefined, "test")).toBeUndefined();
  });

  test("ignores helpers and wrong-stage conventional names with multiple candidates", () => {
    const otherStage = stage === "vertex" ? "fragment" : "vertex";
    for (const extra of [declaration(otherStage, names[stage]), `fn ${names[stage]}() {}`]) {
      const entries = reflectSource(`${extra}\n${declaration(stage, "first")}\n${declaration(stage, "second")}`).entryPoints;
      expect(selectEntryPoint("test", entries, stage, undefined, "test")?.name).toBe("first");
    }
  });
});

const VERTICES = `${declaration("vertex", "preview_vertex")}\n${declaration("vertex", "vs_main")}`;
const FRAGMENTS = `${declaration("fragment", "preview_fragment")}\n${declaration("fragment", "fs_main")}`;
const KERNELS = `${declaration("compute", "preview_compute")}\n${declaration("compute", "cs_main")}`;

test("draw resolves partial overrides independently and caches by resolved entries", async () => {
  const gpu = await init();
  try {
    const shader = `${VERTICES}\n${FRAGMENTS}`;
    const output = target(gpu, { size: [2, 2] });
    const entries = [undefined, { vertex: "vs_main", fragment: "fs_main" }, { vertex: "preview_vertex" }, { fragment: "preview_fragment" }];
    for (const entry of entries) draw(gpu, { shader, entry }).compileSync(output);
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    expect(mock.createRenderPipelineDescriptors.map(d => [d.vertex.entryPoint, d.fragment?.entryPoint])).toEqual([
      ["vs_main", "fs_main"], ["preview_vertex", "fs_main"], ["vs_main", "preview_fragment"],
    ]);
  } finally { gpu.dispose(); }
});

test("effect overrides the fragment and snapshots it before lazy compilation", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [2, 2] });
    const entry = { fragment: "preview_fragment" };
    const explicit = effect(gpu, FRAGMENTS, { entry });
    entry.fragment = "fs_main";
    for (const entry of [undefined, {}, { fragment: undefined }, { fragment: "fs_main" }]) {
      effect(gpu, FRAGMENTS, { entry }).draw(output);
    }
    await explicit.compile(output);
    await frame(gpu, f => f.pass(output, explicit)).done;
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    const descs = [...mock.createRenderPipelineDescriptors, ...mock.createRenderPipelineAsyncDescriptors];
    expect(descs.map(d => d.fragment?.entryPoint)).toEqual(["fs_main", "preview_fragment"]);
    expect(descs.every(d => d.vertex.entryPoint === "vgpu_fullscreen_vs")).toBe(true);
  } finally { gpu.dispose(); }
});

test("effect rejects invalid selections and cannot forward a vertex override", async () => {
  const gpu = await init();
  try {
    for (const entry of [null, 4, "fs_main", [], { fragment: 5 }, { fragment: "missing" }, { fragment: "vs_main" }, { vertex: "preview_vertex" }]) {
      expect(() => effect(gpu, `${VERTICES}\n${FRAGMENTS}`, { entry: entry as never })).toThrow(expect.objectContaining({ code: "VGPU-ENTRY-INVALID" }));
    }
    effect(gpu, `${VERTICES}\n${FRAGMENTS}`).compileSync({ colors: ["rgba8unorm"] });
    expect(getMockGPUDeviceInstrumentation(gpu.gpu).createRenderPipelineDescriptors.at(-1)?.vertex.entryPoint).toBe("vs_main");
  } finally { gpu.dispose(); }
});

test("default vertex metadata drives geometry inputs", async () => {
  const gpu = await init();
  try {
    const shader = `${declaration("vertex", "preview_vertex")}
      @vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0, 1); }
      ${declaration("fragment", "color")}`;
    const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { position: "float32x2" } }] });
    draw(gpu, { shader, geometry: mesh }).compileSync({ colors: ["rgba8unorm"] });
    expect(getMockGPUDeviceInstrumentation(gpu.gpu).createRenderPipelineDescriptors.at(-1)?.vertex.buffers).toEqual([
      { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
    ]);
  } finally { gpu.dispose(); }
});

test("effect resource layouts and fragment storage limits follow the selected entry", async () => {
  const gpu = await init();
  try {
    const shader = `@group(0) @binding(3) var<storage, read> values: array<vec4f>;
      ${declaration("fragment", "preview_fragment")}
      @fragment fn fs_main() -> @location(0) vec4f { return values[0]; }`;
    effect(gpu, shader, { label: "selected-resource" });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    expect([...mock.createBindGroupLayoutDescriptors.at(-1)!.entries].map(e => [e.binding, e.visibility])).toEqual([[3, 2]]);
    Object.defineProperty(gpu.gpu.limits, "maxStorageBuffersInFragmentStage", { value: 0 });
    expect(() => effect(gpu, shader)).toThrow(expect.objectContaining({ code: "VGPU-LIMIT-STORAGE-FRAGMENT" }));
    expect(() => effect(gpu, shader, { entry: { fragment: "preview_fragment" } })).not.toThrow();
  } finally { gpu.dispose(); }
});

test("compute shares concurrent preparation by resolved entry and remains lazy", async () => {
  const gpu = await init();
  try {
    const automatic = compute(gpu, KERNELS);
    const explicit = compute(gpu, KERNELS, { entry: "cs_main" });
    const alternative = compute(gpu, KERNELS, { entry: "preview_compute" });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    expect(mock.calls.createComputePipeline).toBe(0);
    expect(mock.calls.createComputePipelineAsync).toBe(0);
    await Promise.all([automatic.compile(), explicit.compile(), alternative.compile()]);
    expect(mock.createComputePipelineAsyncDescriptors.map(d => d.compute.entryPoint)).toEqual(["cs_main", "preview_compute"]);
    automatic.dispatch(1);
    await frame(gpu, f => f.computePass(p => p.dispatch(explicit, 1))).done;
    expect(mock.calls.createComputePipeline).toBe(0);
  } finally { gpu.dispose(); }
});

test("compute synchronous compilation checks the chosen workgroup size", async () => {
  const gpu = await init();
  try {
    const shader = `${declaration("compute", "preview_compute")}\n@compute @workgroup_size(2) fn cs_main() {}`;
    Object.defineProperty(gpu.gpu.limits, "maxComputeWorkgroupSizeX", { value: 1 });
    expect(() => compute(gpu, shader).compileSync()).toThrow(expect.objectContaining({ code: "VGPU-COMPUTE-WORKGROUP-INVALID", detail: expect.objectContaining({ entry: "cs_main" }) }));
    compute(gpu, shader, { entry: "preview_compute" }).compileSync();
    expect(getMockGPUDeviceInstrumentation(gpu.gpu).createComputePipelineDescriptors.at(-1)?.compute.entryPoint).toBe("preview_compute");
  } finally { gpu.dispose(); }
});

test("compute storage visibility and aliasing use the selected kernel", async () => {
  const gpu = await init();
  try {
    const shader = `@group(0) @binding(0) var<storage, read_write> left: array<u32>;
      @group(0) @binding(1) var<storage, read_write> right: array<u32>;
      @compute @workgroup_size(1) fn preview_compute() { left[0] = 1; }
      @compute @workgroup_size(1) fn cs_main() { left[0] = right[0]; }`;
    const data = storage(gpu, 4);
    const automatic = compute(gpu, shader, { set: { left: data, right: data } });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    expect([...mock.createBindGroupLayoutDescriptors.at(-1)!.entries].map(e => [e.binding, e.visibility])).toEqual([[0, 4], [1, 4]]);
    expect(() => automatic.dispatch(1)).toThrow(expect.objectContaining({ code: "VGPU-R1-STORAGE-ALIASING" }));
    expect(() => compute(gpu, shader, { entry: "preview_compute", set: { left: data } }).dispatch(1)).not.toThrow();
  } finally { gpu.dispose(); }
});
