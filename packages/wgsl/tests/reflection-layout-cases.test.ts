import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

type ExpectedMember = readonly [name: string, offset: number, align: number, size: number | undefined, stride?: number, runtimeSized?: boolean];

const cases: readonly {
  readonly name: string;
  readonly declarations: string;
  readonly binding: string;
  readonly expected: { readonly align: number; readonly size?: number; readonly stride?: number; readonly members?: readonly ExpectedMember[]; readonly runtimeSized?: boolean };
}[] = [
  {
    name: "single f32 uniform struct rounds struct alignment and size to 16",
    declarations: "struct Params { value: f32 }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 16, members: [["value", 0, 4, 4]] },
  },
  {
    name: "vec2 then f32 packs at natural offsets inside a uniform struct",
    declarations: "struct Params { xy: vec2f, z: f32 }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 16, members: [["xy", 0, 8, 8], ["z", 8, 4, 4]] },
  },
  {
    name: "vec3 leaves tail room usable by scalar",
    declarations: "struct Params { v: vec3f, w: f32 }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 16, members: [["v", 0, 16, 12], ["w", 12, 4, 4]] },
  },
  {
    name: "mat3x3 is three vec3 columns with vec4 stride",
    declarations: "struct Params { m: mat3x3f }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 48, members: [["m", 0, 16, 48, 16]] },
  },
  {
    name: "mat3x2 keeps vec2 column alignment and 8-byte column stride",
    declarations: "struct Params { m: mat3x2f }",
    binding: "@group(0) @binding(0) var<storage, read> params: Params;",
    expected: { align: 8, size: 24, members: [["m", 0, 8, 24, 8]] },
  },
  {
    name: "uniform array of f32 uses Dawn/Naga standard-layout natural stride",
    declarations: "struct Params { values: array<f32, 3> }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 16, members: [["values", 0, 16, 12, 4]] },
  },
  {
    name: "storage array of f32 uses natural 4-byte stride",
    declarations: "struct Params { values: array<f32, 3> }",
    binding: "@group(0) @binding(0) var<storage, read> params: Params;",
    expected: { align: 4, size: 12, members: [["values", 0, 4, 12, 4]] },
  },
  {
    name: "array of vec3 uses 16-byte stride",
    declarations: "struct Params { values: array<vec3f, 2> }",
    binding: "@group(0) @binding(0) var<storage, read> params: Params;",
    expected: { align: 16, size: 32, members: [["values", 0, 16, 32, 16]] },
  },
  {
    name: "nested uniform struct starts at 16-byte offset after scalar",
    declarations: "struct Inner { a: vec3f, b: f32 } struct Params { x: f32, inner: Inner }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 32, members: [["x", 0, 4, 4], ["inner", 16, 16, 16]] },
  },
  {
    name: "array of structs uses the struct size as stride when already 16-aligned",
    declarations: "struct Inner { a: vec3f, b: f32 } struct Params { items: array<Inner, 2> }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 32, members: [["items", 0, 16, 32, 16]] },
  },
  {
    name: "explicit align and size attributes override member placement and extent",
    declarations: "struct Params { a: f32, @align(32) @size(32) b: f32 }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 32, size: 64, members: [["a", 0, 4, 4], ["b", 32, 32, 32]] },
  },
  {
    name: "u32 i32 f32 scalars pack as 4-byte host-shareable values",
    declarations: "struct Params { b: u32, c: i32, d: f32 }",
    binding: "@group(0) @binding(0) var<storage, read> params: Params;",
    expected: { align: 4, size: 12, members: [["b", 0, 4, 4], ["c", 4, 4, 4], ["d", 8, 4, 4]] },
  },
  {
    name: "f16 vector layout uses 2-byte scalar size",
    declarations: "enable f16; struct Params { a: f16, b: vec3h }",
    binding: "@group(0) @binding(0) var<storage, read> params: Params;",
    expected: { align: 8, size: 16, members: [["a", 0, 2, 2], ["b", 8, 8, 6]] },
  },
  {
    name: "runtime-sized storage array reports stride and undefined size",
    declarations: "struct Item { p: vec3f, w: f32 }",
    binding: "@group(0) @binding(0) var<storage, read_write> params: array<Item>;",
    expected: { align: 16, size: undefined, stride: 16, runtimeSized: true },
  },
  {
    name: "alias chain resolves before layout",
    declarations: "alias Real = f32; alias V = vec4<Real>; struct Params { color: V }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 16, size: 16, members: [["color", 0, 16, 16]] },
  },
  {
    name: "mixed hard case matches WGSL offsets",
    declarations: "struct Inner { n: vec3f, q: f32 } struct Params { t: f32, v: vec2f, inner: Inner, m: mat3x3f, arr: array<vec3f, 2>, @align(32) tail: vec4f }",
    binding: "@group(0) @binding(0) var<uniform> params: Params;",
    expected: { align: 32, size: 160, members: [["t", 0, 4, 4], ["v", 8, 8, 8], ["inner", 16, 16, 16], ["m", 32, 16, 48, 16], ["arr", 80, 16, 32, 16], ["tail", 128, 32, 16]] },
  },
];

describe("WGSL host-shareable layout reference cases", () => {
  for (const item of cases) {
    test(item.name, async () => {
      const shader = await resolveShader({ entry: "/case.wgsl", validate: false, modules: { "/case.wgsl": `${item.declarations}\n${item.binding}` } });
      const layout = shader.reflection.bindings[0]?.layout;
      expect(layout?.align).toBe(item.expected.align);
      expect(layout?.size).toBe(item.expected.size);
      if (item.expected.stride !== undefined) expect(layout?.stride).toBe(item.expected.stride);
      if (item.expected.runtimeSized !== undefined) expect(layout?.runtimeSized).toBe(item.expected.runtimeSized);
      if (item.expected.members) {
        expect(layout?.members?.map((member) => [member.name, member.offset, member.align, member.size, member.layout.stride].filter((value) => value !== undefined))).toEqual(item.expected.members.map((member) => member.filter((value) => value !== undefined)));
      }
    });
  }
});
