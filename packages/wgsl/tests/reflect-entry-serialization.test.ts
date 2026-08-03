import { expect, test } from "vitest";
import { reflectSource, resolveShader } from "@vgpu/wgsl/runtime";

// The shader from issue #252, verbatim. Note `params` is declared but never referenced, so a
// correct implementation reports only the texture/sampler pair for `fs_main` — the helper-call
// tracing itself was never broken; the metadata was only invisible to structural consumers.
const ISSUE_252 = `struct Params { time: f32, }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn sample_it(uv: vec2f) -> vec4f {
  return textureSample(tex, samp, uv);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return sample_it(uv);
}
`;

test("issue #252: entry-point bindings used through a helper survive JSON.stringify", async () => {
  const { reflection } = await resolveShader({ entry: "/issue-252.wgsl", modules: { "/issue-252.wgsl": ISSUE_252 }, minify: false, validate: false });
  const live = reflection.entryPoints[0]!;

  // Transitive tracing was always correct; `params` is unused so it is legitimately absent.
  expect(live.bindings).toEqual([{ group: 0, binding: 1 }, { group: 0, binding: 2 }]);

  const json = JSON.stringify(reflection.entryPoints);
  expect(json).toContain("bindings");
  expect(json).toContain("samplingPairs");

  const [roundTripped] = JSON.parse(json) as { bindings?: unknown; samplingPairs?: unknown; name?: string }[];
  expect(roundTripped?.name).toBe("fs_main");
  expect(roundTripped?.bindings).toEqual(live.bindings);
  expect(roundTripped?.samplingPairs).toEqual([{ texture: { group: 0, binding: 1 }, sampler: { group: 0, binding: 2 }, mode: "filtering" }]);
});

test("vertex inputs, bindings and sampling pairs all round-trip through JSON", () => {
  const reflection = reflectSource(`
    @group(0) @binding(0) var<uniform> view: vec4f;
    @group(0) @binding(1) var tex: texture_2d<f32>;
    @group(0) @binding(2) var samp: sampler;
    @vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0) + view; }
    @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return textureSample(tex, samp, uv); }
  `);

  const roundTripped = JSON.parse(JSON.stringify(reflection.entryPoints)) as typeof reflection.entryPoints;
  for (const [index, entry] of reflection.entryPoints.entries()) {
    expect(roundTripped[index]?.bindings).toEqual(entry.bindings);
    expect(roundTripped[index]?.samplingPairs).toEqual(entry.samplingPairs);
    expect(roundTripped[index]?.inputs).toEqual(entry.inputs);
  }
  expect(roundTripped[0]?.inputs).toEqual([{ name: "position", location: 0, type: { kind: "vector", width: 2, element: { kind: "scalar", name: "f32" } } }]);
  expect(roundTripped[1]?.inputs).toBeUndefined();
});

test("lossless serialization keeps the whole-program bindings resolveShader re-attaches", async () => {
  const { reflection } = await resolveShader({
    entry: "/main.wgsl",
    minify: false,
    validate: false,
    modules: {
      "/helper.wgsl": `export fn sample_it(t: texture_2d<f32>, s: sampler, uv: vec2f) -> vec4f { return textureSample(t, s, uv); }`,
      "/main.wgsl": `import { sample_it } from "./helper.wgsl";
struct Params { time: f32, }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return sample_it(tex, samp, uv) * params.time; }`,
    },
  });
  const live = reflection.entryPoints[0]!;
  expect(live.bindings).toEqual([{ group: 0, binding: 0 }, { group: 0, binding: 1 }, { group: 0, binding: 2 }]);

  const roundTripped = JSON.parse(JSON.stringify(reflection.entryPoints))[0] as typeof live;
  expect(roundTripped.bindings).toEqual(live.bindings);
  expect(roundTripped.samplingPairs).toEqual(live.samplingPairs);
});

test("toJSON is non-enumerable and does not widen Object.keys or spreads", () => {
  const entry = reflectSource(`
    @group(0) @binding(0) var<uniform> view: vec4f;
    @vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0) + view; }
  `).entryPoints[0]!;

  expect(typeof entry.toJSON).toBe("function");
  expect(Object.keys(entry)).toEqual(["name", "mangledName", "stage", "workgroupSize"]);
  expect(Object.keys({ ...entry })).toEqual(["name", "mangledName", "stage", "workgroupSize"]);
  expect(JSON.stringify({ nested: entry })).toContain("bindings");
});

test("entry-point properties stay configurable so later reflection passes can re-define them", () => {
  const entry = reflectSource("@compute @workgroup_size(1) fn main() {}").entryPoints[0]!;
  for (const key of ["bindings", "samplingPairs", "toJSON"]) {
    expect(Object.getOwnPropertyDescriptor(entry, key)).toMatchObject({ enumerable: false, configurable: true });
  }
});
