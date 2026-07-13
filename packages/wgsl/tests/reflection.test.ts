import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

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
