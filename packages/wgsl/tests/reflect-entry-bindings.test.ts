import { expect, test } from "vitest";
import { reflectSource } from "@vgpu/wgsl/runtime";

const refs = (source: string) => Object.fromEntries(reflectSource(source).entryPoints.map((entry) => [entry.name, entry.bindings]));

test("entry binding reflection follows direct and transitive static use", () => {
  expect(refs(`
    @group(0) @binding(0) var<uniform> direct: vec4f;
    @group(0) @binding(1) var<storage, read> nested: array<u32>;
    @group(1) @binding(0) var unused: texture_2d<f32>;
    fn leaf() -> u32 { return nested[0]; }
    fn helper() -> u32 { return leaf(); }
    @vertex fn vs() -> @builtin(position) vec4f { return direct; }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(f32(helper())); }
    @compute @workgroup_size(1) fn cs() { let x = nested[0]; }
  `)).toEqual({
    vs: [{ group: 0, binding: 0 }],
    fs: [{ group: 0, binding: 1 }],
    cs: [{ group: 0, binding: 1 }],
  });
});

test("local declaration initializers resolve before the local enters scope", () => {
  expect(refs(`
    @group(0) @binding(0) var<storage, read> data: array<u32>;
    @vertex fn vs() -> @builtin(position) vec4f {
      let data = data[0];
      return vec4f(f32(data));
    }
  `)).toEqual({ vs: [{ group: 0, binding: 0 }] });
});

test("uncalled helpers and shadowed parameters do not count globals", () => {
  expect(refs(`
    @group(0) @binding(0) var<storage, read> data: array<u32>;
    fn uncalled() -> u32 { return data[0]; }
    fn shadow(data: u32) -> u32 { return data; }
    @compute @workgroup_size(1) fn main() { let x = shadow(1u); }
  `)).toEqual({ main: [] });
});

test("diamond call graphs deduplicate and sort binding coordinates", () => {
  expect(refs(`
    @group(1) @binding(2) var<storage, read> b: array<u32>;
    @group(0) @binding(3) var<storage, read> a: array<u32>;
    fn leaf() -> u32 { return a[0] + b[0]; }
    fn left() -> u32 { return leaf(); }
    fn right() -> u32 { return leaf(); }
    @compute @workgroup_size(1) fn main() { let x = left() + right(); }
  `)).toEqual({ main: [{ group: 0, binding: 3 }, { group: 1, binding: 2 }] });
});

test("same-stage entry points retain disjoint binding sets", () => {
  expect(refs(`
    @group(0) @binding(0) var<uniform> first: vec4f;
    @group(0) @binding(1) var<uniform> second: vec4f;
    @vertex fn one() -> @builtin(position) vec4f { return first; }
    @vertex fn two() -> @builtin(position) vec4f { return second; }
  `)).toEqual({ one: [{ group: 0, binding: 0 }], two: [{ group: 0, binding: 1 }] });
});

test("valid module assertions and continuing blocks preserve precise use", () => {
  expect(refs(`
    const_assert 1 == 1;
    @group(0) @binding(0) var<storage, read> data: array<u32>;
    @group(0) @binding(1) var<uniform> other: vec4f;
    @compute @workgroup_size(1) fn main() {
      loop { if data[0] == 0 { break; } continuing { let next = data[0]; } }
    }
  `)).toEqual({ main: [{ group: 0, binding: 0 }] });
});

test("analysis fallback conservatively includes every declared binding", () => {
  expect(refs(`
    @group(0) @binding(0) var<storage, read> data: array<u32>;
    @group(0) @binding(1) var<uniform> other: vec4f;
    @compute @workgroup_size(1) fn main() { var<function x = 1u; }
  `)).toEqual({ main: [{ group: 0, binding: 0 }, { group: 0, binding: 1 }] });
});

test("bindings metadata is non-enumerable", () => {
  const entry = reflectSource("@compute @workgroup_size(1) fn main() {}").entryPoints[0]!;
  expect(entry.bindings).toEqual([]);
  expect(Object.keys(entry)).not.toContain("bindings");
});

const pairs = (source: string) => Object.fromEntries(reflectSource(source).entryPoints.map((entry) => [entry.name, entry.samplingPairs]));

test("sampling pairs distinguish loads, ordinary sampling, and comparison", () => {
  expect(pairs(`
    @group(0) @binding(0) var tex: texture_2d<f32>;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var depth: texture_depth_2d;
    @group(0) @binding(3) var cmp: sampler_comparison;
    @fragment fn loaded() -> @location(0) vec4f { return textureLoad(tex, vec2i(0), 0); }
    @fragment fn sampled() -> @location(0) vec4f { return textureSampleLevel(tex, samp, vec2f(0), 0); }
    @fragment fn compared() -> @location(0) vec4f { return vec4f(textureSampleCompare(depth, cmp, vec2f(0), 0)); }
  `)).toEqual({ loaded: [], sampled: [{ texture: { group: 0, binding: 0 }, sampler: { group: 0, binding: 1 }, mode: "filtering" }], compared: [{ texture: { group: 0, binding: 2 }, sampler: { group: 0, binding: 3 }, mode: "comparison" }] });
});

test("sampling pairs compose helper parameters without cross-products", () => {
  expect(pairs(`
    @group(0) @binding(0) var a: texture_2d<f32>;
    @group(0) @binding(1) var sa: sampler;
    @group(0) @binding(2) var b: texture_2d<f32>;
    @group(0) @binding(3) var sb: sampler;
    fn leaf(t: texture_2d<f32>, s: sampler) -> vec4f { return textureSample(t, s, vec2f(0)); }
    fn nested(t: texture_2d<f32>, s: sampler) -> vec4f { return leaf(t, s); }
    @fragment fn main() -> @location(0) vec4f { return nested(a, sa) + nested(b, sb); }
  `).main).toEqual([
    { texture: { group: 0, binding: 0 }, sampler: { group: 0, binding: 1 }, mode: "filtering" },
    { texture: { group: 0, binding: 2 }, sampler: { group: 0, binding: 3 }, mode: "filtering" },
  ]);
});

test("sampling pair metadata is non-enumerable", () => {
  const entry = reflectSource("@compute @workgroup_size(1) fn main() {}").entryPoints[0]!;
  expect(entry.samplingPairs).toEqual([]);
  expect(Object.keys(entry)).not.toContain("samplingPairs");
});

test("compute entries retain ordinary sampling pairs", () => {
  expect(pairs(`
    @group(0) @binding(0) var image: texture_2d<f32>;
    @group(0) @binding(1) var imageSampler: sampler;
    @group(0) @binding(2) var<storage, read_write> output: array<vec4f>;
    @compute @workgroup_size(1) fn main() {
      output[0] = textureSampleLevel(image, imageSampler, vec2f(0.5), 0.0);
    }
  `).main).toEqual([{ texture: { group: 0, binding: 0 }, sampler: { group: 0, binding: 1 }, mode: "filtering" }]);
});

test("unresolved sampled origins fall back to safely promoting every eligible used float texture", () => {
  expect(pairs(`
    @group(0) @binding(0) var image: texture_2d<f32>;
    @group(0) @binding(1) var other: texture_2d<f32>;
    @group(0) @binding(2) var imageSampler: sampler;
    @fragment fn main() -> @location(0) vec4f {
      let indirect = image;
      return textureSample(indirect, imageSampler, vec2f(0.5)) + textureLoad(other, vec2i(0), 0);
    }
  `).main).toEqual([
    { texture: { group: 0, binding: 0 }, sampler: { group: 0, binding: 2 }, mode: "filtering" },
    { texture: { group: 0, binding: 1 }, sampler: { group: 0, binding: 2 }, mode: "filtering" },
  ]);
});
