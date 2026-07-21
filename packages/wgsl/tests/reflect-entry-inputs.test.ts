import { expect, test } from "vitest";
import { reflectSource, resolveShader } from "@vgpu/wgsl/runtime";

test("reflection exposes direct vertex @location input params", () => {
  const entry = reflectSource(`
    enable f16;
    @vertex fn vs(
      @location(0) position: vec3f,
      @location(1) texcoord: vec2<f16>,
      @location(2) index: u32,
      @location(3) color: vec4u,
    ) -> @builtin(position) vec4f { return vec4f(position, 1.0); }
  `).entryPoints[0]!;

  expect(entry.inputs).toEqual([
    { name: "position", location: 0, type: { kind: "vector", width: 3, element: { kind: "scalar", name: "f32" } } },
    { name: "texcoord", location: 1, type: { kind: "vector", width: 2, element: { kind: "scalar", name: "f16" } } },
    { name: "index", location: 2, type: { kind: "scalar", name: "u32" } },
    { name: "color", location: 3, type: { kind: "vector", width: 4, element: { kind: "scalar", name: "u32" } } },
  ]);
});

test("reflection flattens struct-typed vertex inputs and excludes builtins", () => {
  const entry = reflectSource(`
    struct VertexIn {
      @location(0) position: vec3f,
      @builtin(vertex_index) vertexIndex: u32,
      @location(2) uv: vec2f,
    }
    @vertex fn vs(input: VertexIn, @builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
      return vec4f(input.position, 1.0);
    }
  `).entryPoints[0]!;

  expect(entry.inputs).toEqual([
    { name: "position", location: 0, type: { kind: "vector", width: 3, element: { kind: "scalar", name: "f32" } } },
    { name: "uv", location: 2, type: { kind: "vector", width: 2, element: { kind: "scalar", name: "f32" } } },
  ]);
});

test("reflection supports mixed struct and direct vertex inputs", () => {
  const entry = reflectSource(`
    struct VertexIn { @location(0) position: vec2f, @location(1) normal: vec3f }
    @vertex fn vs(input: VertexIn, @location(5) weight: f32) -> @builtin(position) vec4f {
      return vec4f(input.position, weight, 1.0);
    }
  `).entryPoints[0]!;

  expect(entry.inputs?.map((input) => [input.name, input.location])).toEqual([
    ["position", 0],
    ["normal", 1],
    ["weight", 5],
  ]);
});

test("reflection resolves imported struct vertex inputs", async () => {
  const shader = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/types.wgsl": "export struct VertexIn { @location(0) position: vec3f, @location(4) packed: vec4u }",
      "/main.wgsl": `
        import { VertexIn } from "./types.wgsl";
        @vertex fn vs(input: VertexIn) -> @builtin(position) vec4f { return vec4f(input.position, 1.0); }
      `,
    },
  });

  expect(shader.reflection.entryPoints[0]?.inputs?.map((input) => [input.name, input.location, input.type.kind])).toEqual([
    ["position", 0, "vector"],
    ["packed", 4, "vector"],
  ]);
});

test("vertex inputs remain snapshot-safe by staying non-enumerable", () => {
  const entry = reflectSource(`
    @vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); }
  `).entryPoints[0]!;

  expect(entry.inputs?.[0]?.name).toBe("position");
  expect(Object.keys(entry)).toEqual(["name", "mangledName", "stage", "workgroupSize"]);
  expect(JSON.stringify(entry)).not.toContain("inputs");
});

test("non-vertex entry points do not expose inputs", () => {
  const entry = reflectSource(`
    @fragment fn fs(@location(0) color: vec4f) -> @location(0) vec4f { return color; }
  `).entryPoints[0]!;

  expect(entry.inputs).toBeUndefined();
});
