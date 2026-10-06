import { expect, test } from "vitest";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { getMockGPUDeviceInstrumentation, init, compute, draw, effect } from "../src/mock.ts";
import { drawReflection } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import { shaderSourceChecksum } from "../src/shader-source-checksum.ts";
import type { ComputePipeline } from "../src/compute.ts";

const FRAGMENT = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, params.value, 1.0);
}
`;

const DRAW = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(params.value); }
`;

const COMPUTE = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { _ = params.value; }
`;

const RENDER_ENTRIES = `
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return vec4f(f32(vi), 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }
`;

const TWO_BUFFER_LAYOUTS = `
struct Floats { value: f32 }
struct Ints { value: u32 }
@group(0) @binding(0) var<uniform> a: Floats;
@group(0) @binding(1) var<uniform> b: Ints;
${RENDER_ENTRIES}
`;

test("effect(gpu, ...) accepts a prepared ShaderSource", async () => {
  const gpu = await init();
  const fromArtifact = effect(gpu, prepareShader(FRAGMENT), { label: "shader" });

  expect(drawReflection(effectDraw(fromArtifact)).bindings[0]).toMatchObject({ name: "params", group: 0, binding: 0 });
  gpu.dispose();
});

test("draw(gpu, ...) accepts a prepared ShaderSource", async () => {
  const gpu = await init();
  const drawable = draw(gpu, { shader: prepareShader(DRAW), label: "artifact-draw" });

  expect(drawReflection(drawable).bindings[0]).toMatchObject({ name: "params", group: 0, binding: 0 });
  gpu.dispose();
});

test("compute(gpu, ...) accepts ShaderSource", async () => {
  const gpu = await init();
  const job = compute(gpu, prepareShader(COMPUTE), { label: "artifact-compute" });

  job.set({ params: { value: 1 } });
  gpu.dispose();
});

const BUFFER_CONSTRUCTORS = [
  { name: "draw", source: DRAW, construct: (gpu: any, shader: any) => draw(gpu, { shader }) },
  { name: "effect", source: FRAGMENT, construct: (gpu: any, shader: any) => effect(gpu, shader) },
  { name: "compute", source: COMPUTE, construct: (gpu: any, shader: any) => compute(gpu, shader) },
];

test.each(BUFFER_CONSTRUCTORS.flatMap(({ name, source, construct }) => [
  {
    name,
    source,
    construct,
    mutation: "missing packing layout",
    path: "reflection.bindings[0].layout",
    mutate(binding: any) { delete binding.layout; },
  },
  {
    name,
    source,
    construct,
    mutation: "a binding-layout type that contradicts its address space",
    path: "reflection.bindings[0].bindingLayout.buffer.type",
    mutate(binding: any) { binding.bindingLayout.buffer.type = "storage"; },
  },
]))("$name rejects $mutation before creating GPU objects", async ({ source, construct, mutate, path }) => {
  const gpu = await init();
  const artifact = mutableShader(source);
  mutate(artifact.reflection.bindings[0]);
  const calls = getMockGPUDeviceInstrumentation(gpu.device.gpu).calls;
  const before = { ...calls };

  expectInvalidShaderAt(() => construct(gpu, artifact), path);
  expect(calls).toEqual(before);
  gpu.dispose();
});

test("raw WGSL and v1 artifacts are synchronously rejected as unprepared", async () => {
  const gpu = await init();
  expectCode(() => effect(gpu, FRAGMENT as never), "VGPU-SHADER-SOURCE-UNPREPARED");
  expectCode(() => effect(gpu, { version: 1, wgsl: FRAGMENT } as never), "VGPU-SHADER-SOURCE-UNPREPARED");
  gpu.dispose();
});

test("unsupported integer versions identify runtime and producer versions", async () => {
  const gpu = await init();
  expect(() => effect(gpu, { version: 7, producer: "third-party-v7" } as never)).toThrow(expect.objectContaining({
    code: "VGPU-SHADER-SOURCE-VERSION",
    message: expect.stringMatching(/version 7.*supports version 2.*third-party-v7/),
  }));
  gpu.dispose();
});

test("missing fields and checksum mismatches are invalid", async () => {
  const gpu = await init();
  expectCode(() => effect(gpu, { wgsl: FRAGMENT } as never), "VGPU-SHADER-SOURCE-INVALID");
  expectCode(() => effect(gpu, { version: 2, wgsl: FRAGMENT } as never), "VGPU-SHADER-SOURCE-INVALID");
  const changed = mutableShader(FRAGMENT);
  changed.wgsl += "\n";
  expectCode(() => effect(gpu, changed), "VGPU-SHADER-SOURCE-INVALID");
  gpu.dispose();
});

test("snapshot reads consumed own data properties without invoking accessors or hooks", async () => {
  const gpu = await init();
  const artifact = mutableShader(FRAGMENT);
  let invoked = 0;
  Object.defineProperty(artifact, "future", { get() { invoked += 1; return "ignored"; } });
  Object.defineProperty(artifact, "toJSON", { value() { invoked += 1; throw new Error("called toJSON"); } });
  effect(gpu, artifact);
  expect(invoked).toBe(0);

  const hostile = mutableShader(FRAGMENT);
  Object.defineProperty(hostile, "reflection", { get() { invoked += 1; return {}; } });
  expectCode(() => effect(gpu, hostile), "VGPU-SHADER-SOURCE-INVALID");
  expect(invoked).toBe(0);
  gpu.dispose();
});

test("snapshot rejects cycles and sparse arrays", async () => {
  const gpu = await init();
  const cyclic = mutableShader(`struct Params { values: array<vec4f, 2> } @group(0) @binding(0) var<uniform> params: Params; ${DRAW}`);
  const layout = cyclic.reflection.hostShareableLayouts[0].members[0].layout;
  layout.element = layout;
  expectCode(() => draw(gpu, { shader: cyclic }), "VGPU-SHADER-SOURCE-INVALID");

  const sparse = mutableShader(DRAW);
  sparse.reflection.entryPoints = new Array(1);
  expectCode(() => draw(gpu, { shader: sparse }), "VGPU-SHADER-SOURCE-INVALID");
  gpu.dispose();
});

test("intrinsic scalar, vector, atomic and matrix layout corruption is rejected even when duplicate copies agree", async () => {
  const gpu = await init();
  const cases = [
    { source: `struct Params { value: f32 } @group(0) @binding(0) var<uniform> params: Params; ${RENDER_ENTRIES}`, corrupt: corruptLeafLayout },
    { source: `struct Params { value: vec3f } @group(0) @binding(0) var<uniform> params: Params; ${RENDER_ENTRIES}`, corrupt: corruptVectorLayout },
    { source: `struct Params { value: atomic<u32> } @group(0) @binding(0) var<storage, read_write> params: Params; ${RENDER_ENTRIES}`, corrupt: corruptLeafLayout },
    { source: `struct Params { value: mat3x2f } @group(0) @binding(0) var<uniform> params: Params; ${RENDER_ENTRIES}`, corrupt: corruptMatrixElement },
  ];
  for (const { source, corrupt } of cases) {
    const artifact = mutableShader(source);
    for (const layout of duplicateLayouts(artifact)) corrupt(layout);
    artifact.reflection.bindings[0].bindingLayout.buffer.minBindingSize = artifact.reflection.bindings[0].layout.size;
    expectCode(() => draw(gpu, { shader: artifact }), "VGPU-SHADER-SOURCE-INVALID");
  }
  gpu.dispose();
});

test("canonical struct member size must agree with duplicated layout metadata", async () => {
  const gpu = await init();
  const artifact = mutableShader(`
struct Params { first: f32, second: f32 }
@group(0) @binding(0) var<uniform> params: Params;
${RENDER_ENTRIES}
`);
  for (const layout of duplicateLayouts(artifact)) {
    layout.members[0].explicitSize = 8;
    layout.members[0].size = 8;
    layout.members[1].offset = 8;
    layout.size = 12;
  }
  artifact.reflection.bindings[0].bindingLayout.buffer.minBindingSize = 12;

  expectInvalidShaderAt(() => draw(gpu, { shader: artifact }), "reflection.hostShareableLayouts[0].members[0].explicitSize");
  gpu.dispose();
});

test("canonical struct member align must agree with duplicated layout metadata", async () => {
  const gpu = await init();
  const artifact = mutableShader(`
struct Params { first: f32, second: f32 }
@group(0) @binding(0) var<uniform> params: Params;
${RENDER_ENTRIES}
`);
  for (const layout of duplicateLayouts(artifact)) {
    layout.members[0].explicitAlign = 8;
    layout.members[0].align = 8;
    layout.align = 8;
  }

  expectInvalidShaderAt(() => draw(gpu, { shader: artifact }), "reflection.hostShareableLayouts[0].members[0].explicitAlign");
  gpu.dispose();
});

test("a binding cannot use another binding's canonical layout", async () => {
  const gpu = await init();
  const artifact = mutableShader(TWO_BUFFER_LAYOUTS);
  artifact.reflection.bindings[0].layout = structuredClone(artifact.reflection.bindings[1].layout);

  expectInvalidShaderAt(() => draw(gpu, { shader: artifact }), "reflection.bindings[0].layout");
  gpu.dispose();
});

test("a binding layout type must agree even when both layout copies are mutated", async () => {
  const gpu = await init();
  const artifact = mutableShader(TWO_BUFFER_LAYOUTS);
  const binding = artifact.reflection.bindings[0];
  const replacement = structuredClone(artifact.reflection.bindings[1].layout);
  replacement.name = binding.name;
  replacement.mangledName = binding.mangledName;
  binding.layout = structuredClone(replacement);
  artifact.reflection.hostShareableLayouts[0] = replacement;

  expectInvalidShaderAt(() => draw(gpu, { shader: artifact }), "reflection.bindings[0].layout.type");
  gpu.dispose();
});

test("a canonical binding struct must agree with the binding type", async () => {
  const gpu = await init();
  const artifact = mutableShader(TWO_BUFFER_LAYOUTS);
  artifact.reflection.bindings[0].struct = structuredClone(
    artifact.reflection.structs.find((struct: any) => struct.name === "Ints"),
  );

  expectInvalidShaderAt(() => draw(gpu, { shader: artifact }), "reflection.bindings[0].struct");
  gpu.dispose();
});

test("producer-valid explicit align and size metadata is accepted", async () => {
  const gpu = await init();
  const artifact = prepareShader(`
struct Params { first: f32, @align(32) @size(32) second: f32 }
@group(0) @binding(0) var<uniform> params: Params;
${RENDER_ENTRIES}
`);

  expect(() => draw(gpu, { shader: artifact })).not.toThrow();
  gpu.dispose();
});

test("producer-valid nested aliases with f16 runtime arrays are accepted", async () => {
  const gpu = await init();
  const artifact = prepareShader(`
enable f16;
alias Scalar = f16;
alias Pair = vec2<Scalar>;
struct Item { value: Pair }
alias ItemAlias = Item;
alias Items = array<ItemAlias>;
@group(0) @binding(0) var<storage, read> items: Items;
@compute @workgroup_size(1) fn main() { _ = items[0].value.x; }
`);

  expect(() => compute(gpu, artifact)).not.toThrow();
  gpu.dispose();
});

test.each([
  ["direct scalar", "", "f32", "read", "_ = value;"],
  ["aliased scalar f16", "enable f16; alias Value = f16;", "Value", "read", "_ = value;"],
  ["direct vector", "", "vec3<u32>", "read", "_ = value.x;"],
  ["aliased vector", "alias Scalar = f32; alias Value = vec2<Scalar>;", "Value", "read", "_ = value.x;"],
  ["direct padded struct", "struct Value { @align(16) @size(16) item: f32 }", "Value", "read", "_ = value.item;"],
  ["aliased struct", "struct Value { item: vec2<f32> } alias ValueAlias = Value;", "ValueAlias", "read", "_ = value.item.x;"],
  ["direct fixed array", "", "array<vec2<f32>, 2>", "read", "_ = value[0].x;"],
  ["aliased runtime array", "alias Item = u32; alias Value = array<Item>;", "Value", "read", "_ = value[0];"],
  ["read-write storage", "struct Value { item: u32 }", "Value", "read_write", "value.item += 1;"],
] as const)("producer-valid %s binding layout is accepted", async (_case, declarations, type, access, use) => {
  const gpu = await init();
  const artifact = prepareShader(`
${declarations}
@group(0) @binding(0) var<storage, ${access}> value: ${type};
@compute @workgroup_size(1) fn main() { ${use} }
`);

  expect(() => compute(gpu, artifact)).not.toThrow();
  gpu.dispose();
});

test.each([
  ["vector", "vec4<Scalar>", "draw"],
  ["array", "array<vec4<Scalar>, 2>", "compute"],
  ["matrix", "mat3x3<Scalar>", "draw"],
] as const)("producer-valid aliases nested inside %s member layouts are accepted", async (_case, memberType, consumer) => {
  const gpu = await init();
  const artifact = prepareShader(`
alias Scalar = f32;
struct Params { value: ${memberType} }
@group(0) @binding(0) var<uniform> params: Params;
${consumer === "compute" ? "@compute @workgroup_size(1) fn main() {}" : RENDER_ENTRIES}
`);

  expect(() => consumer === "compute" ? compute(gpu, artifact) : draw(gpu, { shader: artifact })).not.toThrow();
  gpu.dispose();
});

test("dangling nested sampling relationships are rejected", async () => {
  const gpu = await init();
  const artifact = mutableShader(`
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return textureSample(tex, smp, uv); }
`);
  artifact.reflection.entryPoints[0].samplingPairs[0].texture.binding = 99;
  expectCode(() => effect(gpu, artifact), "VGPU-SHADER-SOURCE-INVALID");
  gpu.dispose();
});

test("constructors inspect each artifact and isolate handles from later mutation", async () => {
  const gpu = await init();
  const artifact = mutableShader(DRAW);
  const drawable = draw(gpu, { shader: artifact });
  artifact.reflection.bindings[0].name = "changed";
  artifact.reflection.entryPoints.find((entry: any) => entry.bindings.length > 0).bindings[0].binding = 99;
  expect(drawReflection(drawable).bindings[0].name).toBe("params");
  expect(Object.isFrozen(drawReflection(drawable))).toBe(true);
  expectCode(() => draw(gpu, { shader: artifact }), "VGPU-SHADER-SOURCE-INVALID");
  gpu.dispose();
});

test("unresolved workgroup sentinels decode privately while finite dimensions stay exact", async () => {
  const gpu = await init();
  const unresolved = compute(gpu, prepareShader("override WIDTH: u32; @compute @workgroup_size(WIDTH, 2, 1) fn main() {}"), { constants: { WIDTH: 8 } }) as ComputePipeline;
  const finite = compute(gpu, prepareShader("@compute @workgroup_size(8, 2, 1) fn main() {}")) as ComputePipeline;
  expect(unresolved.reflection.entryPoints[0].workgroupSize).toEqual([Number.NaN, 2, 1]);
  expect(finite.reflection.entryPoints[0].workgroupSize).toEqual([8, 2, 1]);
  gpu.dispose();
});

test("runtime checksum matches producer vectors", () => {
  const vectors = [
    ["", "fnv1a64-utf16le-v1:cbf29ce484222325"],
    ["\r\n", "fnv1a64-utf16le-v1:2d011698a05df6b2"],
    ["// café", "fnv1a64-utf16le-v1:13dd75f9ae4a4218"],
    ["// 😀", "fnv1a64-utf16le-v1:7d409d963d0bc9ca"],
    ["// \ud800", "fnv1a64-utf16le-v1:a8dbb29252a528a5"],
    ["// \udc00", "fnv1a64-utf16le-v1:a8dbae9252a521d9"],
  ] as const;
  for (const [source, checksum] of vectors) {
    expect(shaderSourceChecksum(source)).toBe(checksum);
    expect(prepareShader(source).sourceChecksum).toBe(checksum);
  }
});

type MutableShader = ReturnType<typeof mutableShader>;

function mutableShader(source: string): any {
  return structuredClone(prepareShader(source));
}

function duplicateLayouts(artifact: MutableShader): any[] {
  return [artifact.reflection.bindings[0].layout, artifact.reflection.hostShareableLayouts[0]];
}

function corruptLeafLayout(layout: any): void {
  layout.align = 8;
  layout.size = 8;
  layout.members[0].align = 8;
  layout.members[0].size = 8;
  layout.members[0].layout.align = 8;
  layout.members[0].layout.size = 8;
}

function corruptVectorLayout(layout: any): void {
  layout.members[0].size = 16;
  layout.members[0].layout.size = 16;
}

function corruptMatrixElement(layout: any): void {
  layout.members[0].layout.element.type.width = 3;
}

function expectCode(fn: () => unknown, code: string): void {
  expect(fn).toThrow(expect.objectContaining({ code }));
}

function expectInvalidShaderAt(fn: () => unknown, path: string): void {
  expect(fn).toThrow(expect.objectContaining({
    code: "VGPU-SHADER-SOURCE-INVALID",
    detail: expect.objectContaining({ path }),
  }));
}
