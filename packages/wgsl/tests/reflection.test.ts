import { expect, test } from "vitest";
import { reflectSource, resolveShader } from "@vgpu/wgsl/runtime";

test("reflection extracts bindings", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@group(1) @binding(2) var<storage> data: array<u32>;" }, validate: false })).reflection.bindings[0]).toMatchObject({ group: 1, binding: 2, name: "data", kind: "buffer", addressSpace: "storage" }));
test("reflection reports compute entry", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(2,3,4) fn main(){}" }, validate: false })).reflection.entryPoints[0]).toMatchObject({ stage: "compute", name: "main", workgroupSize: [2, 3, 4] }));
test("reflection uses original names", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false })).reflection.entryPoints[0]).toMatchObject({ name: "main", mangledName: "main" }));
test("reflection extracts enable features", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "enable f16;" }, validate: false })).reflection.featuresRequired).toContain("f16"));

test("reflection resolves aliases and nested structs through imports", async () => {
  const shader = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/types.wgsl": `
        export alias Real = f32;
        export struct Inner { a: vec3f, b: Real }
      `,
      "/main.wgsl": `
        import { Inner as ImportedInner } from "./types.wgsl";
        struct Params { inner: ImportedInner, values: array<vec2f, 3> }
        @group(0) @binding(0) var<uniform> params: Params;
        @fragment fn main() -> @location(0) vec4f { return vec4f(params.inner.b); }
      `,
    },
  });
  expect(shader.reflection.structs.find((item) => item.name === "Params")?.members[0]?.type).toMatchObject({ kind: "identifier", mangledName: expect.stringContaining("__Inner") });
  expect(shader.reflection.bindings[0]).toMatchObject({ name: "params", addressSpace: "uniform", kind: "buffer" });
  expect(shader.reflection.bindings[0]?.layout).toMatchObject({ align: 16, size: 48 });
});

test("reflection extracts texture and sampler bindings", async () => {
  const shader = await resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    @group(0) @binding(0) var tex: texture_2d<f32>;
    @group(0) @binding(1) var smp: sampler_comparison;
  ` } });
  expect(shader.reflection.bindings).toEqual([
    expect.objectContaining({ name: "tex", kind: "texture" }),
    expect.objectContaining({ name: "smp", kind: "sampler" }),
  ]);
});

test("layout handles mat3x3 vec3 padding and explicit member attributes", async () => {
  const shader = await resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    struct Params {
      a: f32,
      b: vec3f,
      m: mat3x3f,
      @align(32) @size(32) c: f32,
    }
    @group(0) @binding(0) var<uniform> params: Params;
  ` } });
  const layout = shader.reflection.bindings[0]?.layout;
  expect(layout).toMatchObject({ align: 32, size: 128 });
  expect(layout?.members?.map((m) => [m.name, m.offset, m.align, m.size])).toEqual([
    ["a", 0, 4, 4],
    ["b", 16, 16, 12],
    ["m", 32, 16, 48],
    ["c", 96, 32, 32],
  ]);
});

test("uniform and storage arrays use Naga/Dawn standard-layout natural stride", async () => {
  const shader = await resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    struct U { values: array<f32, 3> }
    struct S { values: array<f32, 3> }
    @group(0) @binding(0) var<uniform> u: U;
    @group(0) @binding(1) var<storage, read> s: S;
  ` } });
  expect(shader.reflection.bindings[0]?.layout?.members?.[0]?.layout).toMatchObject({ stride: 4, size: 12 });
  expect(shader.reflection.bindings[1]?.layout?.members?.[0]?.layout).toMatchObject({ stride: 4, size: 12 });
});

test("runtime-sized arrays are reported for storage layouts", async () => {
  const shader = await resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    struct Item { p: vec3f, w: f32 }
    @group(0) @binding(0) var<storage, read_write> items: array<Item>;
  ` } });
  expect(shader.reflection.bindings[0]).toMatchObject({ access: "read_write" });
  expect(shader.reflection.bindings[0]?.layout).toMatchObject({ runtimeSized: true, stride: 16, size: undefined });
});


test("reflection rejects non-literal array lengths with canonical fix-it", async () => {
  await expect(resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    override COUNT: u32 = 4u;
    struct Params { values: array<f32, COUNT> }
    @group(0) @binding(0) var<uniform> params: Params;
  ` } })).rejects.toThrow("literal length required for auto layout; use draw.group(n, bg) manual binding");
});

test("reflection entry detection does not use regex to classify later non-entry functions", async () => {
  const shader = await resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    @compute @workgroup_size(1) fn main() {}
    fn helper() {}
  ` } });
  expect(shader.reflection.entryPoints).toEqual([expect.objectContaining({ name: "main", mangledName: "main", stage: "compute" })]);
});

test("reflection rejects namespace-imported type references with fix-it", async () => {
  await expect(resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/types.wgsl": "export struct Params { value: f32 }",
      "/main.wgsl": `
        import * as Types from "./types.wgsl";
        @group(0) @binding(0) var<uniform> params: Types.Params;
      `,
    },
  })).rejects.toThrow("type 'Types.Params' is a namespace-member import; use a named import or manual @group(1+) binding");
});

test("reflection rejects bool in host-shareable layout with canonical fix-it", async () => {
  await expect(resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    struct Params { enabled: bool }
    @group(0) @binding(0) var<uniform> params: Params;
  ` } })).rejects.toThrow("VGPUError: `bool` no es host-shareable en uniform/storage. Fix: usá `u32` (0 | 1) → struct Params { enabled: u32 }");
});

test("reflection classifies texture bindings for exact BGL entries", async () => {
  const shader = await resolveShader({ entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": `
    @group(0) @binding(0) var hdr: texture_2d<f32>;
    @group(0) @binding(1) var depth: texture_depth_2d;
    @group(0) @binding(2) var cubeTex: texture_cube<f32>;
    @group(0) @binding(3) var volume: texture_storage_3d<rgba16float, read_write>;
  ` } });
  expect(shader.reflection.bindings.map((binding) => binding.bindingLayout)).toEqual([
    { kind: "texture", texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
    { kind: "texture", texture: { sampleType: "depth", viewDimension: "2d", multisampled: false } },
    { kind: "texture", texture: { sampleType: "unfilterable-float", viewDimension: "cube", multisampled: false } },
    { kind: "storageTexture", storageTexture: { access: "read-write", format: "rgba16float", viewDimension: "3d" } },
  ]);
});


test("reflectSource reflects raw WGSL strings through the frozen ReflectionFacade", () => {
  const reflection = reflectSource(`
    struct Params { time: f32, values: array<f32, 3> }
    @group(0) @binding(0) var<uniform> params: Params;
    @group(0) @binding(1) var tex: texture_2d<f32>;
    @fragment fn main() -> @location(0) vec4f { return vec4f(params.time); }
  `);
  expect(reflection.entryPoints[0]).toMatchObject({ name: "main", stage: "fragment" });
  expect(reflection.bindings[0]).toMatchObject({ name: "params", kind: "buffer", bindingLayout: { kind: "buffer" } });
  expect(reflection.bindings[0]?.layout).toMatchObject({ layoutMode: "naga-standard", size: 32 });
  expect(reflection.bindings[1]).toMatchObject({ name: "tex", kind: "texture", bindingLayout: { kind: "texture" } });
});

test("reflectSource rejects import graphs and points callers to resolveShader", () => {
  expect(() => reflectSource(`import { color } from "./palette.wgsl";`)).toThrowError(/resolveShader/);
  try {
    reflectSource(`import { color } from "./palette.wgsl";`);
    throw new Error("expected reflectSource to reject imports");
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-WGSL-REFLECT-SOURCE-IMPORT" });
  }
});
