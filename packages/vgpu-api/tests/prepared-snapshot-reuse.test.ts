import { prepareShader } from "@vgpu/wgsl/prepare";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { shaderSourceModule } from "../../wgsl/src/loader-shared/emit.ts";
import { evaluateShaderModule } from "../../wgsl/tests/helpers/evaluate-shader-module.ts";
import { drawBindingState, drawReflection, type InternalDraw } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import type { ComputePipeline } from "../src/compute.ts";
import { compute, draw, effect, init, target } from "../src/mock.ts";
import { clonePreparedShaderData } from "../src/shader-source-snapshot.ts";
import { shaderSourceChecksum } from "../src/shader-source-checksum.ts";

// Count validation work without timers or test hooks: wrap the real implementations in spies.
vi.mock("../src/shader-source-snapshot.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shader-source-snapshot.ts")>();
  return { ...actual, clonePreparedShaderData: vi.fn(actual.clonePreparedShaderData) };
});
vi.mock("../src/shader-source-checksum.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shader-source-checksum.ts")>();
  return { ...actual, shaderSourceChecksum: vi.fn(actual.shaderSourceChecksum) };
});

const clones = vi.mocked(clonePreparedShaderData);
const checksums = vi.mocked(shaderSourceChecksum);
const { shaderSourceChecksum: realChecksum } = await vi.importActual<typeof import("../src/shader-source-checksum.ts")>("../src/shader-source-checksum.ts");

beforeEach(() => {
  clones.mockClear();
  checksums.mockClear();
});

const DRAW = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(params.value); }
`;

const FRAGMENT = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, params.value, 1.0); }
`;

const COMPUTE = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { _ = params.value; }
`;

const CYCLIC = `struct Params { values: array<vec4f, 2> } @group(0) @binding(0) var<uniform> params: Params; ${DRAW}`;

type Construct = (gpu: Awaited<ReturnType<typeof init>>, shader: any, opts?: { label?: string; entry?: unknown }) => unknown;

const CONSTRUCTORS: readonly { readonly name: string; readonly source: string; readonly construct: Construct; readonly badEntry: unknown }[] = [
  { name: "draw", source: DRAW, construct: (gpu, shader, opts = {}) => draw(gpu, { shader, ...opts } as never), badEntry: { vertex: "missing" } },
  { name: "effect", source: FRAGMENT, construct: (gpu, shader, opts = {}) => effect(gpu, shader, opts as never), badEntry: { fragment: "missing" } },
  { name: "compute", source: COMPUTE, construct: (gpu, shader, opts = {}) => compute(gpu, shader, opts as never), badEntry: "missing" },
];

describe("immutable prepared artifacts are validated once and share one snapshot", () => {
  test("25 draws from one artifact validate once and keep independent per-draw state", async () => {
    const gpu = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(DRAW)));
    const color = target(gpu, { size: [1, 1] });
    const draws = Array.from({ length: 25 }, (_, index) =>
      draw(gpu, { shader: artifact, label: `mesh-${index}`, set: { params: { value: index } } }));

    expect(clones).toHaveBeenCalledTimes(1);
    expect(checksums).toHaveBeenCalledTimes(1);
    const shared = drawReflection(draws[0]!);
    expect(Object.isFrozen(shared)).toBe(true);
    for (const item of draws) expect(drawReflection(item)).toBe(shared);
    expect(new Set(draws.map((item) => (item as InternalDraw).label)).size).toBe(25);

    draws[3]!.set({ params: { value: 30 } });
    draws[4]!.set({ params: { value: 40 } });
    draws[3]!.draw(color);
    draws[4]!.draw(color);
    expect(uniformFloat(draws[3]!)).toBe(30);
    expect(uniformFloat(draws[4]!)).toBe(40);
    expect(bindingBuffer(draws[3]!)).not.toBe(bindingBuffer(draws[4]!));
    gpu.dispose();
  });

  test("effects and computes validate once per distinct artifact, not per call", async () => {
    const gpu = await init();
    const render = deepFreeze(structuredClone(prepareShader(DRAW)));
    const kernel = deepFreeze(structuredClone(prepareShader(COMPUTE)));
    const draws = Array.from({ length: 10 }, (_, index) => draw(gpu, { shader: render, label: `draw-${index}` }));
    const effects = Array.from({ length: 10 }, (_, index) => effect(gpu, render, { label: `effect-${index}` }));
    const computes = Array.from({ length: 10 }, (_, index) => compute(gpu, kernel, { label: `compute-${index}` }) as ComputePipeline);

    expect(clones).toHaveBeenCalledTimes(2);
    expect(checksums).toHaveBeenCalledTimes(2);
    for (const item of effects) expect(drawReflection(effectDraw(item))).toBe(drawReflection(draws[0]!));
    for (const item of computes) expect(item.reflection).toBe(computes[0]!.reflection);
    expect(computes.map((item) => item.label)).toEqual(Array.from({ length: 10 }, (_, index) => `compute-${index}`));
    gpu.dispose();
  });

  test("two gpus reuse one snapshot while keeping their GPU objects independent", async () => {
    const first = await init();
    const second = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(DRAW)));
    const a = draw(first, { shader: artifact, label: "a", set: { params: { value: 1 } } });
    const b = draw(second, { shader: artifact, label: "b", set: { params: { value: 2 } } });

    expect(clones).toHaveBeenCalledTimes(1);
    expect(drawReflection(a)).toBe(drawReflection(b));
    first.dispose();

    const c = draw(second, { shader: artifact, label: "c", set: { params: { value: 3 } } });
    const color = target(second, { size: [1, 1] });
    b.draw(color);
    c.draw(color);
    expect(uniformFloat(b)).toBe(2);
    expect(uniformFloat(c)).toBe(3);
    expect(clones).toHaveBeenCalledTimes(1);
    second.dispose();
  });

  test("externally deep-frozen artifacts are cached like producer output", async () => {
    const gpu = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(DRAW)));
    for (let index = 0; index < 5; index++) draw(gpu, { shader: artifact });
    expect(clones).toHaveBeenCalledTimes(1);
    gpu.dispose();
  });

  test("200 constructions: immutable validates once, mutable revalidates each time but hashes once", async () => {
    const gpu = await init();
    const immutable = deepFreeze(structuredClone(prepareShader(DRAW)));
    for (let index = 0; index < 200; index++) draw(gpu, { shader: immutable });
    expect(clones).toHaveBeenCalledTimes(1);
    expect(checksums).toHaveBeenCalledTimes(1);

    clones.mockClear();
    checksums.mockClear();
    const mutable = structuredClone(prepareShader(DRAW));
    for (let index = 0; index < 200; index++) draw(gpu, { shader: mutable });
    expect(clones).toHaveBeenCalledTimes(200);
    expect(checksums).toHaveBeenCalledTimes(1);
    gpu.dispose();
  });
});

describe("artifacts that are not proven immutable keep per-construction validation", () => {
  test("a root-only frozen artifact is revalidated and later nested corruption is detected", async () => {
    const gpu = await init();
    const artifact = Object.freeze(structuredClone(prepareShader(DRAW))) as any;
    const first = draw(gpu, { shader: artifact });
    for (let index = 1; index < 5; index++) draw(gpu, { shader: artifact });
    expect(clones).toHaveBeenCalledTimes(5);

    artifact.reflection.bindings[0].name = "changed";
    expectInvalidAt(() => draw(gpu, { shader: artifact }), "reflection.bindings[0].layout");
    expect(drawReflection(first).bindings[0]!.name).toBe("params");
    expect(Object.isFrozen(drawReflection(first))).toBe(true);
    gpu.dispose();
  });

  test("a graph frozen everywhere except one nested object is revalidated", async () => {
    const gpu = await init();
    const artifact = structuredClone(prepareShader(DRAW)) as any;
    const buffer = artifact.reflection.bindings[0].bindingLayout.buffer;
    deepFreeze(artifact, new Set([buffer]));
    expect(Object.isFrozen(artifact.reflection.bindings[0].bindingLayout)).toBe(true);
    for (let index = 0; index < 3; index++) draw(gpu, { shader: artifact });
    expect(clones).toHaveBeenCalledTimes(3);

    buffer.type = "storage";
    expectInvalidAt(() => draw(gpu, { shader: artifact }), "reflection.bindings[0].bindingLayout.buffer.type");
    gpu.dispose();
  });

  test("an object spread of an immutable artifact takes the mutable path", async () => {
    const gpu = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(DRAW)));
    const spread = { ...artifact };
    for (let index = 0; index < 4; index++) draw(gpu, { shader: spread });
    expect(clones).toHaveBeenCalledTimes(4);
    expect(checksums).toHaveBeenCalledTimes(1);
    gpu.dispose();
  });

  test("an unchanged mutable artifact hashes once; changed text rehashes and a changed checksum is compared", async () => {
    const gpu = await init();
    const artifact = structuredClone(prepareShader(DRAW)) as any;
    const original = { wgsl: artifact.wgsl, sourceChecksum: artifact.sourceChecksum };
    for (let index = 0; index < 5; index++) draw(gpu, { shader: artifact });
    expect(clones).toHaveBeenCalledTimes(5);
    expect(checksums).toHaveBeenCalledTimes(1);

    artifact.wgsl += "\n";
    expectInvalidAt(() => draw(gpu, { shader: artifact }), "sourceChecksum", "checksum does not match wgsl");
    expect(checksums).toHaveBeenCalledTimes(2);

    artifact.wgsl = original.wgsl;
    artifact.sourceChecksum = "fnv1a64-utf16le-v1:0000000000000000";
    expectInvalidAt(() => draw(gpu, { shader: artifact }), "sourceChecksum", "checksum does not match wgsl");
    expect(checksums).toHaveBeenCalledTimes(3);
    artifact.sourceChecksum = original.sourceChecksum;
    draw(gpu, { shader: artifact });
    expect(checksums).toHaveBeenCalledTimes(3);
    artifact.sourceChecksum = "fnv1a64-utf16le-v1:0000000000000000";
    expectInvalidAt(() => draw(gpu, { shader: artifact }), "sourceChecksum", "checksum does not match wgsl");
    expect(checksums).toHaveBeenCalledTimes(3);

    const revised = `${original.wgsl}// revised\n`;
    artifact.wgsl = revised;
    artifact.sourceChecksum = realChecksum(revised);
    draw(gpu, { shader: artifact });
    expect(checksums).toHaveBeenCalledTimes(4);

    artifact.sourceChecksum = "not-a-checksum";
    expectInvalidAt(() => draw(gpu, { shader: artifact }), "sourceChecksum", "expected fnv1a64-utf16le-v1 followed by 16 lowercase hexadecimal digits");
    expect(checksums).toHaveBeenCalledTimes(4);
    gpu.dispose();
  });

  test("equal WGSL never lets independently supplied metadata share validation", async () => {
    const gpu = await init();
    const valid = structuredClone(prepareShader(DRAW)) as any;
    const corrupt = structuredClone(prepareShader(DRAW)) as any;
    corrupt.reflection.bindings[0].bindingLayout.buffer.type = "storage";
    expect(corrupt.wgsl).toBe(valid.wgsl);
    expect(corrupt.sourceChecksum).toBe(valid.sourceChecksum);
    draw(gpu, { shader: valid });
    expectInvalidAt(() => draw(gpu, { shader: corrupt }), "reflection.bindings[0].bindingLayout.buffer.type");

    clones.mockClear();
    const frozenA = deepFreeze(structuredClone(prepareShader(DRAW)));
    const frozenB = deepFreeze(structuredClone(prepareShader({ wgsl: DRAW, functionExports: [{ name: "f", resolvedName: "f_1", parameterNames: ["x"] }] })));
    const frozenCorrupt = deepFreeze(corrupt);
    for (let index = 0; index < 2; index++) {
      draw(gpu, { shader: frozenA });
      draw(gpu, { shader: frozenB });
      expectInvalidAt(() => draw(gpu, { shader: frozenCorrupt }), "reflection.bindings[0].bindingLayout.buffer.type");
    }
    expect(clones).toHaveBeenCalledTimes(4);
    gpu.dispose();
  });

  test("structuredClone of an immutable artifact is mutable, independent, valid and revalidated", async () => {
    const gpu = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(DRAW)));
    const copy = structuredClone(artifact) as any;
    expect(Object.isFrozen(copy)).toBe(false);
    expect(Object.isFrozen(copy.reflection.bindings[0])).toBe(false);
    expect(copy).toStrictEqual(artifact);
    for (let index = 0; index < 3; index++) draw(gpu, { shader: copy });
    expect(clones).toHaveBeenCalledTimes(3);
    copy.reflection.bindings[0].name = "copy-only";
    expect(artifact.reflection.bindings[0]!.name).toBe("params");
    gpu.dispose();
  });
});

describe("invalid and hostile inputs are never cached", () => {
  test.each(CONSTRUCTORS.flatMap(({ name, source, construct }) => [
    { name, source, construct, corruption: "bindingLayout type mismatch", path: "reflection.bindings[0].bindingLayout.buffer.type", corrupt(artifact: any) { artifact.reflection.bindings[0].bindingLayout.buffer.type = "storage"; } },
    { name, source, construct, corruption: "checksum mismatch", path: "sourceChecksum", corrupt(artifact: any) { artifact.wgsl += "\n"; } },
    { name, source, construct, corruption: "duplicate binding coordinate", path: "reflection.bindings[1]", corrupt(artifact: any) { artifact.reflection.bindings.push(structuredClone(artifact.reflection.bindings[0])); } },
  ]))("$name rejects a deep-frozen artifact with $corruption on every attempt", async ({ source, construct, corrupt, path }) => {
    const gpu = await init();
    const artifact = structuredClone(prepareShader(source)) as any;
    corrupt(artifact);
    deepFreeze(artifact);
    const errors = [0, 1, 2].map(() => captureError(() => construct(gpu, artifact, { label: "corrupt" })));

    expect(clones).toHaveBeenCalledTimes(3);
    for (const error of errors) {
      expect(error).toMatchObject({ code: "VGPU-SHADER-SOURCE-INVALID", where: "shader source", detail: { path } });
      expect(errorIdentity(error)).toEqual(errorIdentity(errors[0]));
    }
    expect(() => construct(gpu, deepFreeze(structuredClone(prepareShader(source))))).not.toThrow();
    gpu.dispose();
  });

  test("frozen cyclic metadata reports the cycle each time", async () => {
    const gpu = await init();
    const artifact = structuredClone(prepareShader(CYCLIC)) as any;
    const layout = artifact.reflection.hostShareableLayouts[0].members[0].layout;
    layout.element = layout;
    deepFreeze(artifact);
    for (let index = 0; index < 3; index++) {
      expect(() => draw(gpu, { shader: artifact })).toThrow(expect.objectContaining({
        code: "VGPU-SHADER-SOURCE-INVALID",
        detail: expect.objectContaining({ reason: "cyclic metadata is not allowed" }),
      }));
    }
    expect(clones).toHaveBeenCalledTimes(3);
    gpu.dispose();
  });

  test("a frozen consumed accessor is rejected without invoking it; an unconsumed one is ignored and cached", async () => {
    const gpu = await init();
    let invoked = 0;
    const consumed = structuredClone(prepareShader(DRAW)) as any;
    const bindings = consumed.reflection.bindings;
    Object.defineProperty(consumed.reflection, "bindings", { enumerable: true, get() { invoked += 1; return bindings; } });
    deepFreeze(consumed);
    for (let index = 0; index < 2; index++) {
      expectInvalidAt(() => draw(gpu, { shader: consumed }), "reflection.bindings", "accessor properties are not allowed");
    }
    expect(clones).toHaveBeenCalledTimes(2);

    clones.mockClear();
    const extra = structuredClone(prepareShader(DRAW)) as any;
    Object.defineProperty(extra, "future", { enumerable: true, get() { invoked += 1; return {}; } });
    extra.notes = { mutable: true };
    deepFreeze(extra, new Set([extra.notes]));
    for (let index = 0; index < 3; index++) draw(gpu, { shader: extra });
    expect(clones).toHaveBeenCalledTimes(1);
    expect(invoked).toBe(0);
    gpu.dispose();
  });

  test("a proxy whose integrity check throws behaves as a mutable artifact", async () => {
    const gpu = await init();
    const proxy = new Proxy(structuredClone(prepareShader(DRAW)), { isExtensible: () => false });
    expect(() => Object.isFrozen(proxy)).toThrow(TypeError);
    for (let index = 0; index < 3; index++) expect(() => draw(gpu, { shader: proxy })).not.toThrow();
    expect(clones).toHaveBeenCalledTimes(3);
    gpu.dispose();
  });

  test("a root frozen only after its version was read is not cached", async () => {
    const gpu = await init();
    const target = structuredClone(prepareShader(DRAW)) as any;
    for (const key of ["reflection", "functionExports"] as const) if (key in target) deepFreeze(target[key]);
    target.version = 3;
    let versionRead = false;
    const proxy = new Proxy(target, {
      isExtensible(object) {
        if (versionRead) Object.freeze(object);
        return Reflect.isExtensible(object);
      },
      getOwnPropertyDescriptor(object, key) {
        if (key === "version" && !versionRead) {
          versionRead = true;
          return { value: 2, writable: true, enumerable: true, configurable: true };
        }
        // Freeze while the remaining fields are inspected, after the version answer was already given.
        if (versionRead) Object.freeze(object);
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });

    expect(() => draw(gpu, { shader: proxy })).not.toThrow();
    expect(Object.isFrozen(target)).toBe(true);
    expect(() => draw(gpu, { shader: proxy })).toThrow(expect.objectContaining({ code: "VGPU-SHADER-SOURCE-VERSION" }));
    gpu.dispose();
  });

  test("objects derived from a cached artifact are not served from the cache", async () => {
    const gpu = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(DRAW)));
    draw(gpu, { shader: artifact });
    expectInvalidAt(() => draw(gpu, { shader: Object.create(artifact) }), "version", "missing required own data property");

    const forged = structuredClone(artifact) as any;
    forged.reflection.bindings[0].bindingLayout.buffer.type = "storage";
    forged.validated = true;
    forged.snapshot = drawReflection(draw(gpu, { shader: artifact }));
    deepFreeze(forged);
    expectInvalidAt(() => draw(gpu, { shader: forged }), "reflection.bindings[0].bindingLayout.buffer.type");
    expectInvalidAt(() => draw(gpu, { shader: forged }), "reflection.bindings[0].bindingLayout.buffer.type");
    gpu.dispose();
  });

  test("reentrant construction from a proxy trap keeps each artifact's own eligibility", async () => {
    const gpu = await init();
    const mutable = structuredClone(prepareShader(DRAW));
    const frozenInner = deepFreeze(structuredClone(prepareShader(FRAGMENT)));
    const invalidInner = structuredClone(prepareShader(DRAW)) as any;
    invalidInner.wgsl += "\n";
    let reentered = 0;
    // The nested reflection is only inspected while the outer clone runs, so the trap re-enters mid-clone.
    const outer = withProxiedReflection(deepFreeze(structuredClone(prepareShader(DRAW))), true, (key) => {
      if (key !== "bindings" || reentered > 0) return;
      reentered += 1;
      draw(gpu, { shader: mutable });
      try { draw(gpu, { shader: invalidInner }); } catch { /* expected */ }
    });

    draw(gpu, { shader: outer });
    expect(reentered).toBe(1);
    expect(clones).toHaveBeenCalledTimes(3);
    draw(gpu, { shader: outer });
    expect(reentered).toBe(1);
    expect(clones).toHaveBeenCalledTimes(3);

    // A mutable container visited after the reentrant call must still disqualify the outer artifact.
    const exportsSource = structuredClone(prepareShader({ wgsl: DRAW, functionExports: [{ name: "f", resolvedName: "f_1", parameterNames: ["x"] }] })) as any;
    const mutableExports = exportsSource.functionExports;
    const late = withProxiedReflection(deepFreeze(exportsSource, new Set([mutableExports])), true, (key) => {
      if (key === "bindings") draw(gpu, { shader: mutable });
    });
    draw(gpu, { shader: late });
    draw(gpu, { shader: late });
    mutableExports.push({ name: "", resolvedName: "g_1", parameterNames: [] });
    expectInvalidAt(() => draw(gpu, { shader: late }), "functionExports[1].name");

    // So must a mutable container visited before it: the reentrant call restores, not resets, the outer state.
    const earlySource = structuredClone(prepareShader(DRAW)) as any;
    const mutableBindings = earlySource.reflection.bindings;
    const early = withProxiedReflection(deepFreeze(earlySource, new Set([mutableBindings])), true, (key) => {
      if (key === "hostShareableLayouts") draw(gpu, { shader: mutable });
    });
    draw(gpu, { shader: early });
    draw(gpu, { shader: early });
    mutableBindings.push(structuredClone(mutableBindings[0]));
    expectInvalidAt(() => draw(gpu, { shader: early }), "reflection.bindings[1]");

    clones.mockClear();
    const mutableOuter = withProxiedReflection(deepFreeze(structuredClone(prepareShader(DRAW))), false, (key) => {
      if (key === "bindings") effect(gpu, frozenInner);
    });
    draw(gpu, { shader: mutableOuter });
    draw(gpu, { shader: mutableOuter });
    expect(clones).toHaveBeenCalledTimes(3);
    gpu.dispose();
  });
});

describe("caller-owned data, labels and errors", () => {
  test("producer output rejects writes; copies and caller inputs stay mutable and unaliased", async () => {
    const gpu = await init();
    const functionExports = [{ name: "tint", resolvedName: "tint_1", parameterNames: ["color"] }];
    const artifact = prepareShader({ wgsl: DRAW, functionExports }) as any;

    expect(() => { artifact.wgsl = ""; }).toThrow(TypeError);
    expect(() => { artifact.reflection.bindings[0].name = "x"; }).toThrow(TypeError);
    expect(() => { artifact.functionExports[0].parameterNames.push("y"); }).toThrow(TypeError);
    expect(Object.isFrozen(functionExports)).toBe(false);
    expect(Object.isFrozen(functionExports[0]!.parameterNames)).toBe(false);
    expect(artifact.functionExports).not.toBe(functionExports);
    expect(artifact.functionExports[0].parameterNames).not.toBe(functionExports[0]!.parameterNames);
    functionExports[0]!.parameterNames.push("later");
    expect(artifact.functionExports[0].parameterNames).toEqual(["color"]);

    const drawable = draw(gpu, { shader: artifact });
    expect(drawReflection(drawable)).not.toBe(artifact.reflection);
    expect(drawReflection(drawable)).toEqual(artifact.reflection);
    expect(clones).toHaveBeenCalledTimes(1);
    gpu.dispose();
  });

  test.each(CONSTRUCTORS)("$name errors from a cached artifact name the current call's label", async ({ source, construct, badEntry }) => {
    const gpu = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(source)));
    construct(gpu, artifact, { label: "first-call" });
    const error = captureError(() => construct(gpu, artifact, { label: "second-call", entry: badEntry }));

    expect(clones).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "VGPU-ENTRY-INVALID" });
    expect(String((error as Error).message)).toContain("second-call");
    expect(String((error as Error).message)).not.toContain("first-call");
    gpu.dispose();
  });

  test.each(CONSTRUCTORS)("$name reports a disposed gpu before any snapshot error or cache hit", async ({ name, source, construct }) => {
    const gpu = await init();
    const artifact = deepFreeze(structuredClone(prepareShader(source)));
    construct(gpu, artifact);
    const corrupt = structuredClone(prepareShader(source)) as any;
    corrupt.wgsl += "\n";
    gpu.dispose();
    clones.mockClear();

    expect(() => construct(gpu, artifact)).toThrow(expect.objectContaining({ code: "VGPU-GPU-DISPOSED", where: name }));
    expect(() => construct(gpu, deepFreeze(corrupt))).toThrow(expect.objectContaining({ code: "VGPU-GPU-DISPOSED", where: name }));
    expect(clones).not.toHaveBeenCalled();
  });
});

describe("loader-emitted artifacts", () => {
  const LARGE = largeShaderSource();

  test.each([
    { form: "literal", source: DRAW, path: "/fixtures/reuse-literal.wgsl", entry: undefined },
    { form: "packed", source: LARGE, path: "/fixtures/reuse-packed.wgsl", entry: { vertex: "vs_main", fragment: "fs_main" } },
  ])("$form modules are deeply frozen, equal prepareShader() and validate once", async ({ form, source, path, entry }) => {
    const gpu = await init();
    const emitted = shaderSourceModule(source, path, []);
    expect(emitted.includes("decodePackedMetadata")).toBe(form === "packed");
    const artifact = await evaluateShaderModule(emitted);
    const prepared = prepareShader({ wgsl: source, functionExports: [] }, path);

    expect(isDeeplyFrozen(artifact)).toBe(true);
    expect(artifact).toStrictEqual(prepared);
    const draws = Array.from({ length: 5 }, () => draw(gpu, { shader: artifact, ...(entry ? { entry } : {}) }));
    expect(clones).toHaveBeenCalledTimes(1);
    expect(drawReflection(draws[4]!)).toBe(drawReflection(draws[0]!));
    expect(drawReflection(draws[0]!)).toEqual(drawReflection(draw(gpu, { shader: prepared, ...(entry ? { entry } : {}) })));

    clones.mockClear();
    const spread = { ...artifact };
    for (let index = 0; index < 3; index++) draw(gpu, { shader: spread, ...(entry ? { entry } : {}) });
    expect(clones).toHaveBeenCalledTimes(3);
    gpu.dispose();
  });

  test("a revised module evaluates to a new artifact with its own snapshot", async () => {
    const gpu = await init();
    const path = "/fixtures/hmr.wgsl";
    const revision1 = await evaluateShaderModule(shaderSourceModule(DRAW, path, []));
    const revision2 = await evaluateShaderModule(shaderSourceModule(DRAW.replace("vec4f(params.value)", "vec4f(params.value * 2.0)"), path, []));
    const old = draw(gpu, { shader: revision1 });
    const next = draw(gpu, { shader: revision2 });

    expect(revision2).not.toBe(revision1);
    expect(revision2.wgsl).not.toBe(revision1.wgsl);
    expect(revision2.sourceChecksum).not.toBe(revision1.sourceChecksum);
    expect(drawReflection(next)).not.toBe(drawReflection(old));
    expect(clones).toHaveBeenCalledTimes(2);
    expect(drawReflection(draw(gpu, { shader: revision1 }))).toBe(drawReflection(old));
    expect(clones).toHaveBeenCalledTimes(2);
    gpu.dispose();
  });
});

function deepFreeze<T>(value: T, skip: ReadonlySet<object> = new Set(), seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, skip, seen);
  }
  if (!skip.has(value)) Object.freeze(value);
  return value;
}

function withProxiedReflection(artifact: any, freezeRoot: boolean, onDescriptor: (key: string | symbol) => void): any {
  const reflection = new Proxy(artifact.reflection, {
    getOwnPropertyDescriptor(object, key) {
      onDescriptor(key);
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });
  const root = { ...artifact, reflection };
  return freezeRoot ? Object.freeze(root) : root;
}

function isDeeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((nested) => isDeeplyFrozen(nested, seen));
}

function bindingBuffer(drawable: ReturnType<typeof draw>): GPUBuffer {
  return (drawBindingState(drawable, "params")?.resource as GPUBufferBinding).buffer;
}

function uniformFloat(drawable: ReturnType<typeof draw>): number {
  const buffer = bindingBuffer(drawable) as GPUBuffer & { __vgpuMockBytes?: Uint8Array };
  if (!buffer.__vgpuMockBytes) throw new Error("fixture did not expose mock buffer bytes");
  return new DataView(buffer.__vgpuMockBytes.buffer, buffer.__vgpuMockBytes.byteOffset).getFloat32(0, true);
}

function captureError(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected the construction to throw");
}

function errorIdentity(error: unknown): unknown {
  const { code, where, detail, message } = error as { code: string; where: string; detail: unknown; message: string };
  return { code, where, detail, message };
}

function expectInvalidAt(run: () => unknown, path: string, reason?: string): void {
  expect(run).toThrow(expect.objectContaining({
    code: "VGPU-SHADER-SOURCE-INVALID",
    where: "shader source",
    detail: expect.objectContaining({ path, ...(reason ? { reason } : {}) }),
  }));
}

function largeShaderSource(): string {
  const members = Array.from({ length: 8 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `m${index}: ${type},`;
  }).join("\n");
  return `
struct RuntimeParams {
${members}
}
@group(0) @binding(0) var<uniform> params0: RuntimeParams;
@group(0) @binding(1) var<uniform> params1: RuntimeParams;
@group(0) @binding(2) var<uniform> params2: RuntimeParams;
@group(0) @binding(3) var<uniform> params3: RuntimeParams;
@group(0) @binding(4) var sourceTexture: texture_2d<f32>;
@group(0) @binding(5) var sourceSampler: sampler;
override WG_SIZE: u32 = 1;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32(index), params0.m2.x, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f {
  return textureSample(sourceTexture, sourceSampler, vec2f(0.5)) + params1.m2;
}
@compute @workgroup_size(WG_SIZE, 2, 1) fn cs_main() {
  _ = params2.m0;
}
`;
}
