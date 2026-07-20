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
